import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { data, error } = await supabase
    .from('project_files')
    .select('*')
    .eq('project_id', params.id)
    .order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data || []);
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const projectId = params.id;
  const fd = await req.formData();
  const fileType = String(fd.get('file_type') || 'misc');

  const files: File[] = [];
  for (const value of fd.getAll('files')) {
    if (value instanceof File && value.size > 0) files.push(value);
  }
  for (const value of fd.getAll('file')) {
    if (value instanceof File && value.size > 0) files.push(value);
  }
  if (files.length === 0) {
    return NextResponse.json({ error: 'No files provided' }, { status: 400 });
  }

  const inserted: unknown[] = [];
  for (const file of files) {
    const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const objectKey = `${projectId}/${fileType}/${Date.now()}_${safe}`;
    const ab = await file.arrayBuffer();
    const { error: upErr } = await supabase.storage
      .from('project-files')
      .upload(objectKey, Buffer.from(ab), {
        contentType: file.type || 'application/octet-stream',
        upsert: false,
      });
    if (upErr) {
      console.warn('[projecthub] upload failed:', upErr.message);
      continue;
    }
    const { data, error } = await supabase
      .from('project_files')
      .insert({
        project_id: projectId,
        file_type: fileType,
        file_path: objectKey,
        original_name: file.name,
      })
      .select()
      .single();
    if (error) {
      console.warn('[projecthub] DB insert failed:', error.message);
      continue;
    }
    inserted.push(data);
  }

  return NextResponse.json(inserted);
}
