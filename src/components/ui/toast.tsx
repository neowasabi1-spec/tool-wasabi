'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, Info, AlertTriangle, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Tiny, dependency-free toast system.
 *
 * Usage from anywhere (components, event handlers, async code):
 *   import { toast } from '@/components/ui/toast';
 *   toast.success('Saved');
 *   toast.error('Something went wrong');
 *
 * Mount <Toaster /> once near the app root.
 */

type ToastType = 'success' | 'error' | 'info' | 'warning';

interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
  duration: number;
}

type Listener = (items: ToastItem[]) => void;

let items: ToastItem[] = [];
let seq = 0;
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l(items);
}

function push(type: ToastType, message: string, duration = 4000) {
  const id = ++seq;
  items = [...items, { id, type, message, duration }];
  emit();
  if (duration > 0) {
    setTimeout(() => dismiss(id), duration);
  }
  return id;
}

function dismiss(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

export const toast = Object.assign(
  (message: string, duration?: number) => push('info', message, duration),
  {
    success: (message: string, duration?: number) => push('success', message, duration),
    error: (message: string, duration?: number) => push('error', message, duration),
    info: (message: string, duration?: number) => push('info', message, duration),
    warning: (message: string, duration?: number) => push('warning', message, duration),
    dismiss,
  },
);

const styles: Record<ToastType, { icon: typeof Info; ring: string; iconColor: string }> = {
  success: { icon: CheckCircle2, ring: 'border-green-200', iconColor: 'text-green-600' },
  error: { icon: XCircle, ring: 'border-red-200', iconColor: 'text-red-600' },
  info: { icon: Info, ring: 'border-indigo-200', iconColor: 'text-indigo-600' },
  warning: { icon: AlertTriangle, ring: 'border-amber-200', iconColor: 'text-amber-600' },
};

export function Toaster() {
  const [list, setList] = useState<ToastItem[]>(items);

  useEffect(() => {
    const l: Listener = (next) => setList(next);
    listeners.add(l);
    setList(items);
    return () => {
      listeners.delete(l);
    };
  }, []);

  if (list.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 w-[340px] max-w-[calc(100vw-2rem)]">
      {list.map((t) => {
        const s = styles[t.type];
        const Icon = s.icon;
        return (
          <div
            key={t.id}
            className={cn(
              'flex items-start gap-3 bg-white rounded-xl border shadow-lg p-3.5 animate-in',
              s.ring,
            )}
            style={{ animation: 'toast-in .18s ease-out' }}
          >
            <Icon className={cn('w-5 h-5 shrink-0 mt-0.5', s.iconColor)} />
            <p className="flex-1 text-sm text-gray-800 leading-snug">{t.message}</p>
            <button
              onClick={() => dismiss(t.id)}
              className="text-gray-400 hover:text-gray-600 shrink-0"
              aria-label="Dismiss"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        );
      })}
      <style jsx global>{`
        @keyframes toast-in {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
