import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

const EXTRACT_PROMPT = `You are a product catalog parser. Extract ALL products from the provided content.

Return a JSON array where each element is an object. Each object MUST have at least a "name" field.
Include any other fields you can identify: sku, price, category, description, brand, quantity, etc.

RULES:
- Extract EVERY product mentioned, even if information is minimal
- The "name" field is REQUIRED for each product
- Use consistent field names across all products
- price should be a string (keep currency symbols if present)
- Return ONLY the JSON array, no other text
- If no products found, return an empty array []

Example output:
[
  {"name": "Product A", "sku": "SKU-001", "price": "€49.00", "category": "Health"},
  {"name": "Product B", "price": "$29.99"}
]`;

const SPREADSHEET_EXTENSIONS = ['csv', 'xlsx', 'xls', 'tsv', 'ods'];
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'tif'];

export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get('content-type') || '';
    let rows: Record<string, string>[];

    if (contentType.includes('application/json')) {
      const body = await request.json();
      const { text, base64, mimeType } = body;

      if (text) {
        rows = await parseTextWithAI(text);
      } else if (base64 && mimeType) {
        const buffer = Buffer.from(base64, 'base64');
        if (mimeType === 'application/pdf') {
          rows = await parsePDF(buffer);
        } else if (mimeType.startsWith('image/')) {
          rows = await parseImage(buffer, mimeType);
        } else {
          rows = await parseTextWithAI(buffer.toString('utf-8'));
        }
      } else {
        return NextResponse.json({ error: 'Missing text or base64 data' }, { status: 400 });
      }
    } else {
      const formData = await request.formData();
      const file = formData.get('file') as File;

      if (!file) {
        return NextResponse.json({ error: 'No file provided' }, { status: 400 });
      }

      const ext = file.name.split('.').pop()?.toLowerCase() || '';
      const buffer = Buffer.from(await file.arrayBuffer());

      if (SPREADSHEET_EXTENSIONS.includes(ext)) {
        rows = parseSpreadsheet(buffer);
      } else if (ext === 'json') {
        rows = parseJSONFile(buffer);
      } else if (ext === 'pdf') {
        rows = await parsePDF(buffer);
      } else if (IMAGE_EXTENSIONS.includes(ext)) {
        rows = await parseImage(buffer, file.type || `image/${ext}`);
      } else {
        const text = buffer.toString('utf-8');
        rows = await parseTextWithAI(text);
      }
    }

    if (rows.length === 0) {
      return NextResponse.json({ error: 'No products found in file' }, { status: 400 });
    }

    const normalized = rows.map(row => {
      const obj: Record<string, string> = {};
      for (const [k, v] of Object.entries(row)) {
        obj[k] = v != null ? String(v) : '';
      }
      return obj;
    });

    return NextResponse.json({ rows: normalized });
  } catch (error) {
    console.error('Catalog parse error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to parse file' },
      { status: 500 }
    );
  }
}

// ===== Structured formats =====

function parseSpreadsheet(buffer: Buffer): Record<string, string>[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const XLSX = require('xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: '' }) as Record<string, string>[];
}

function parseJSONFile(buffer: Buffer): Record<string, string>[] {
  const text = buffer.toString('utf-8');
  const parsed = JSON.parse(text);

  if (Array.isArray(parsed)) {
    return parsed.map(item => {
      if (typeof item === 'string') return { name: item };
      if (typeof item === 'object' && item !== null) return item;
      return { name: String(item) };
    });
  }

  if (typeof parsed === 'object' && parsed !== null) {
    for (const key of ['products', 'items', 'data', 'results', 'prodotti', 'catalogo', 'catalog']) {
      if (Array.isArray(parsed[key])) return parsed[key];
    }
  }

  throw new Error('JSON must contain an array of products or an object with a products/items array');
}

// ===== AI-powered parsing =====

async function parsePDF(buffer: Buffer): Promise<Record<string, string>[]> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (anthropicKey) {
    return await parseWithClaudeDocument(anthropicKey, buffer, 'application/pdf');
  }

  if (openaiKey) {
    const text = buffer.toString('utf-8');
    const cleanText = text.replace(/[^\x20-\x7E\n\r\t\u00C0-\u024F]/g, ' ').replace(/\s+/g, ' ').trim();
    if (cleanText.length > 100) {
      return await parseTextWithOpenAI(openaiKey, cleanText);
    }
    throw new Error('Cannot extract text from this PDF. Add ANTHROPIC_API_KEY for native PDF support.');
  }

  throw new Error('No AI API key configured for PDF parsing');
}

async function parseImage(buffer: Buffer, mimeType: string): Promise<Record<string, string>[]> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const base64 = buffer.toString('base64');

  if (anthropicKey) {
    return await parseWithClaudeVision(anthropicKey, base64, mimeType);
  }
  if (openaiKey) {
    return await parseWithOpenAIVision(openaiKey, base64, mimeType);
  }

  throw new Error('No AI API key configured for image parsing');
}

async function parseTextWithAI(text: string): Promise<Record<string, string>[]> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!anthropicKey && !openaiKey) {
    throw new Error('No AI API key configured');
  }

  const truncated = text.substring(0, 50000);

  if (openaiKey) {
    return await parseTextWithOpenAI(openaiKey, truncated);
  }
  return await parseTextWithClaude(anthropicKey!, truncated);
}

// ===== Claude helpers =====

async function parseWithClaudeDocument(apiKey: string, buffer: Buffer, mediaType: string): Promise<Record<string, string>[]> {
  const base64 = buffer.toString('base64');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: EXTRACT_PROMPT },
        ],
      }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error: ${response.status} – ${err}`);
  }

  const data = await response.json();
  return parseAIResponse(data.content?.[0]?.text || '[]');
}

async function parseWithClaudeVision(apiKey: string, base64: string, mimeType: string): Promise<Record<string, string>[]> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
          { type: 'text', text: EXTRACT_PROMPT },
        ],
      }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error: ${response.status} – ${err}`);
  }

  const data = await response.json();
  return parseAIResponse(data.content?.[0]?.text || '[]');
}

async function parseTextWithClaude(apiKey: string, text: string): Promise<Record<string, string>[]> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8192,
      system: EXTRACT_PROMPT,
      messages: [{ role: 'user', content: `Extract products from this document:\n\n${text}` }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error: ${response.status} – ${err}`);
  }

  const data = await response.json();
  return parseAIResponse(data.content?.[0]?.text || '[]');
}

// ===== OpenAI helpers =====

async function parseTextWithOpenAI(apiKey: string, text: string): Promise<Record<string, string>[]> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 8192,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: EXTRACT_PROMPT + '\n\nWrap the array in an object: {"products": [...]}' },
        { role: 'user', content: `Extract products from this document:\n\n${text}` },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API error: ${response.status} – ${err}`);
  }

  const data = await response.json();
  const responseText = data.choices?.[0]?.message?.content || '{}';

  try {
    const parsed = JSON.parse(responseText);
    if (parsed.products && Array.isArray(parsed.products)) return parsed.products;
    return parseAIResponse(responseText);
  } catch {
    return parseAIResponse(responseText);
  }
}

async function parseWithOpenAIVision(apiKey: string, base64: string, mimeType: string): Promise<Record<string, string>[]> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
          { type: 'text', text: EXTRACT_PROMPT },
        ],
      }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API error: ${response.status} – ${err}`);
  }

  const data = await response.json();
  return parseAIResponse(data.choices?.[0]?.message?.content || '[]');
}

// ===== Response parser =====

function parseAIResponse(text: string): Record<string, string>[] {
  let jsonStr = text.trim();

  const codeMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeMatch) jsonStr = codeMatch[1].trim();

  const arrMatch = jsonStr.match(/\[[\s\S]*\]/);
  if (arrMatch) jsonStr = arrMatch[0];

  if (!jsonStr.startsWith('[')) {
    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try {
        const obj = JSON.parse(objMatch[0]);
        for (const key of ['products', 'items', 'data', 'results', 'prodotti']) {
          if (Array.isArray(obj[key])) return obj[key];
        }
      } catch { /* continue */ }
    }
  }

  try {
    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch {
    throw new Error('AI could not extract products from this file. Try a different format.');
  }
}
