import { db, must } from './db';

export type BatchKind = 'auto' | 'family' | 'hooks' | 'manual' | 'legacy' | 'template';

/** Un lotto = una generazione lanciata dall'utente, con data e parametri. Concept e output ci restano collegati. */
export async function createBatch(productId: string, kind: BatchKind, label: string, params: Record<string, unknown> = {}): Promise<string> {
  const row = must(await db().from('jev_batches').insert({ product_id: productId, kind, label, params }).select('id').single()) as { id: string };
  return row.id;
}
