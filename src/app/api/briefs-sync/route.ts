import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const SHARED_FILE = path.resolve('C:/Users/Utente1/Desktop/wasabi/shared/product_briefs.json');

export async function POST(req: NextRequest) {
  try {
    const { briefs } = await req.json();
    if (!briefs || typeof briefs !== 'object') {
      return NextResponse.json({ error: 'Invalid briefs data' }, { status: 400 });
    }

    let existing: Record<string, string> = {};
    try {
      existing = JSON.parse(fs.readFileSync(SHARED_FILE, 'utf-8'));
    } catch { /* file doesn't exist yet */ }

    const merged = { ...existing, ...briefs };
    fs.writeFileSync(SHARED_FILE, JSON.stringify(merged, null, 2), 'utf-8');

    return NextResponse.json({ ok: true, count: Object.keys(merged).length });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function GET() {
  try {
    const data = JSON.parse(fs.readFileSync(SHARED_FILE, 'utf-8'));
    return NextResponse.json({ briefs: data });
  } catch {
    return NextResponse.json({ briefs: {} });
  }
}
