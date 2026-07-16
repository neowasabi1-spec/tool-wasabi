'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';

/**
 * Promise-based confirm dialog to replace the native window.confirm().
 *
 * Usage:
 *   import { confirmDialog } from '@/components/ui/confirm';
 *   if (await confirmDialog({ title: 'Delete?', message: '…', danger: true })) { … }
 *
 * Mount <ConfirmHost /> once near the app root.
 */

interface ConfirmOptions {
  title?: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

interface ConfirmState extends ConfirmOptions {
  id: number;
  resolve: (v: boolean) => void;
}

type Listener = (s: ConfirmState | null) => void;

let current: ConfirmState | null = null;
let seq = 0;
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l(current);
}

export function confirmDialog(options: ConfirmOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    current = { id: ++seq, ...options, resolve };
    emit();
  });
}

function settle(value: boolean) {
  if (current) {
    current.resolve(value);
    current = null;
    emit();
  }
}

export function ConfirmHost() {
  const [state, setState] = useState<ConfirmState | null>(current);

  useEffect(() => {
    const l: Listener = (s) => setState(s);
    listeners.add(l);
    setState(current);
    return () => {
      listeners.delete(l);
    };
  }, []);

  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') settle(false);
      if (e.key === 'Enter') settle(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state]);

  if (!state) return null;

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 p-4"
      onClick={() => settle(false)}
    >
      <div
        className="w-full max-w-md bg-white rounded-2xl shadow-2xl p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          {state.danger && (
            <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center shrink-0">
              <AlertTriangle className="w-5 h-5 text-red-600" />
            </div>
          )}
          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-gray-900">
              {state.title || 'Conferma'}
            </h3>
            {state.message && (
              <p className="text-sm text-gray-500 mt-1 whitespace-pre-wrap">{state.message}</p>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <button
            type="button"
            onClick={() => settle(false)}
            className="inline-flex items-center justify-center rounded-lg font-medium transition-colors h-10 px-4 text-sm bg-gray-100 text-gray-800 hover:bg-gray-200"
          >
            {state.cancelText || 'Annulla'}
          </button>
          <button
            type="button"
            onClick={() => settle(true)}
            className={`inline-flex items-center justify-center rounded-lg font-medium transition-colors h-10 px-4 text-sm text-white shadow-sm ${
              state.danger
                ? 'bg-red-600 hover:bg-red-700'
                : 'bg-indigo-600 hover:bg-indigo-700'
            }`}
          >
            {state.confirmText || 'Conferma'}
          </button>
        </div>
      </div>
    </div>
  );
}
