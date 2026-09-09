'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DollarSign } from 'lucide-react';
import { humanizePageTypeSlug } from '@/types';
import type { ChimeraProductSlot } from '@/lib/archive-placement';

export function ChimeraProductPrices({
  slots,
  productName,
  values,
  onChange,
  disabled,
}: {
  slots: ChimeraProductSlot[];
  productName: string;
  values: Record<string, string>;
  onChange: (key: string, price: string) => void;
  disabled?: boolean;
}) {
  const upsells = slots.filter((s) => s.role === 'upsell').length;
  const headline = slots.length === 1
    ? 'Price for this product'
    : `Chimera will create ${slots.length} products — enter each price`;

  return (
    <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
      <div className="flex items-start gap-2">
        <DollarSign className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
        <div>
          <p className="text-sm font-medium text-foreground">{headline}</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {upsells > 0
              ? `Read from the steps you ticked: main offer + ${upsells} upsell${upsells === 1 ? '' : 's'}/downsell${upsells === 1 ? '' : 's'}. Clone/Swipe prints these prices as-is.`
              : 'No upsell or downsell selected — only the main offer needs a price.'}
          </p>
        </div>
      </div>
      <div className="space-y-3">
        {slots.map((slot, i) => {
          const typeLabel = slot.pageType ? humanizePageTypeSlug(slot.pageType) : '';
          const title = slot.role === 'main'
            ? `Main product${productName.trim() ? ` — ${productName.trim()}` : ''}`
            : (typeLabel || `Upsell ${i}`);
          const extra = slot.role === 'main'
            ? (typeLabel ? ` · ${typeLabel}` : '')
            : (slot.stepName ? ` · ${slot.stepName}` : '');
          return (
            <div key={slot.key} className="space-y-1">
              <Label htmlFor={`ap-price-${slot.key}`} className="text-xs">
                {i + 1}. {title}
                {extra ? <span className="text-muted-foreground font-normal">{extra}</span> : null}
              </Label>
              <Input
                id={`ap-price-${slot.key}`}
                value={values[slot.key] || ''}
                onChange={(e) => onChange(slot.key, e.target.value)}
                placeholder="e.g. $49 · €39.90 · 3 for $99"
                disabled={disabled}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
