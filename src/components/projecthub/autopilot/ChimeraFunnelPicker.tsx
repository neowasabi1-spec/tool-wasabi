'use client';

import { useEffect, useState } from 'react';
import { authFetch } from '@/lib/auth/client-fetch';
import { pickerFunnelsFromArchive } from '@/lib/archive-placement';

type PickerFunnel = {
  id: string;
  name: string;
  totalSteps: number;
  upsells: number;
  products: number;
  isProject: boolean;
};

/** Shared Templates → Funnel dropdown for Chimera (in-project and New project). */
export function ChimeraFunnelPicker({
  value,
  onChange,
  disabled,
  id = 'ap-funnel',
  selectClassName = 'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm disabled:opacity-50',
}: {
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  id?: string;
  selectClassName?: string;
}) {
  const [funnels, setFunnels] = useState<PickerFunnel[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch('/api/valchiria/funnels', { cache: 'no-store' });
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok) {
          setError((data && data.error) || `Could not load funnels (${res.status})`);
          return;
        }
        const rows = Array.isArray(data?.funnels) ? data.funnels : [];
        setFunnels(pickerFunnelsFromArchive(rows));
      } catch (e) {
        if (!cancelled) setError((e as Error).message || 'Could not load funnels');
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium leading-none">
        Funnel to build (from templates)
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={selectClassName}
      >
        <option value="">— No funnel: main product only —</option>
        {funnels.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name} · {f.products} products ({f.upsells} upsells){f.isProject ? '' : ' · library'}
          </option>
        ))}
      </select>
      {loaded && error && <p className="text-xs text-red-500">{error}</p>}
      {loaded && !error && funnels.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No multi-step funnels in Templates yet. Whatever you see under Templates → Funnel appears here.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Pick one funnel and it drives everything automatically: the landing is generated as an HTML mockup
        inspired by the funnel&apos;s main page (style + structure), and the final step generates 1 main product
        image + one per upsell — the count is read from the funnel, no number to type.
      </p>
    </div>
  );
}
