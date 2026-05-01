import { NextResponse } from 'next/server';
import { supabase, checkSupabaseConnection } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    // Check basic connection
    const connectionCheck = await checkSupabaseConnection();
    
    // Try to list tables
    const tables = ['products', 'swipe_templates', 'funnel_pages', 'post_purchase_pages'];
    const tableStatus: Record<string, { exists: boolean; count?: number; error?: string }> = {};
    
    for (const table of tables) {
      try {
        const { count, error } = await supabase
          .from(table)
          .select('*', { count: 'exact', head: true });
        
        if (error) {
          tableStatus[table] = { exists: false, error: error.message };
        } else {
          tableStatus[table] = { exists: true, count: count || 0 };
        }
      } catch (err) {
        tableStatus[table] = { 
          exists: false, 
          error: err instanceof Error ? err.message : 'Unknown error' 
        };
      }
    }
    
    const allTablesExist = Object.values(tableStatus).every(t => t.exists);
    
    return NextResponse.json({
      success: connectionCheck.connected && allTablesExist,
      connection: connectionCheck,
      tables: tableStatus,
      message: allTablesExist 
        ? 'All tables are configured correctly!' 
        : 'Some tables are missing. Run the SQL schema in Supabase.',
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    });
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      message: 'Error during Supabase connection test',
    }, { status: 500 });
  }
}
