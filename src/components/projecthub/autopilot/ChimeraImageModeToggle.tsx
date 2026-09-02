'use client';

export type ChimeraImageMode = 'affiliate' | 'internal';

export function ChimeraImageModeToggle({
  value,
  onChange,
  disabled,
}: {
  value: ChimeraImageMode;
  onChange: (mode: ChimeraImageMode) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium leading-none">Landing images</p>
      <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-0.5">
        {([
          ['affiliate', 'Affiliate'],
          ['internal', 'Internal'],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            disabled={disabled}
            onClick={() => onChange(id)}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors disabled:opacity-50 ${
              value === id
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {value === 'affiliate'
          ? 'Puts Image landings files into the matching sections of the funnel you picked, unchanged. Skips the invented mockup.'
          : 'Full restyle: new color palette + every photo regenerated in batches. Upload a product photo to lock colors; otherwise Chimera invents a mockup.'}
      </p>
    </div>
  );
}
