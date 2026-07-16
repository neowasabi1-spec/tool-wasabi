'use client';

import { ReactNode } from 'react';

interface HeaderProps {
  title: string;
  subtitle?: string;
  /** Optional page-level actions rendered on the right (e.g. primary button). */
  actions?: ReactNode;
}

export default function Header({ title, subtitle, actions }: HeaderProps) {
  return (
    <header className="sticky top-0 z-30 bg-white/80 backdrop-blur-md border-b border-gray-200/80 px-6 py-4 shadow-[0_1px_2px_0_rgba(0,0,0,0.03)]">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex items-center gap-3">
          <span className="hidden sm:block h-8 w-1 rounded-full bg-gradient-to-b from-indigo-500 to-violet-600" />
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-gray-900 tracking-tight truncate">{title}</h1>
            {subtitle && <p className="text-sm text-gray-500 mt-0.5 truncate">{subtitle}</p>}
          </div>
        </div>

        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
    </header>
  );
}
