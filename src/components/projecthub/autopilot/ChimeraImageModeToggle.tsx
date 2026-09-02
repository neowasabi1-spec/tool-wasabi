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
          ? 'Puts the images / GIFs / videos from Competitor Library → Image landings into the funnel you picked, unchanged.'
          : 'Takes those Image landings assets and swipes them onto this project’s product inside the funnel you picked.'}
      </p>
    </div>
  );
}
