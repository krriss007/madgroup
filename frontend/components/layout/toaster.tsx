"use client";

import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useTerminal } from '@/lib/terminal-context';
import { cn } from '@/lib/utils';

const LEVEL_STYLES: Record<string, string> = {
  info: 'border-sky-500/40 bg-sky-950/60 text-sky-100',
  success: 'border-emerald-500/40 bg-emerald-950/60 text-emerald-100',
  warning: 'border-amber-500/40 bg-amber-950/60 text-amber-100',
  error: 'border-rose-500/50 bg-rose-950/70 text-rose-100',
};

const LEVEL_ICONS: Record<string, JSX.Element> = {
  info: <Info className="h-4 w-4 text-sky-300" />,
  success: <CheckCircle2 className="h-4 w-4 text-emerald-300" />,
  warning: <AlertTriangle className="h-4 w-4 text-amber-300" />,
  error: <XCircle className="h-4 w-4 text-rose-300" />,
};

export function Toaster(): JSX.Element {
  const { toasts, dismissToast } = useTerminal();

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[22rem] flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={cn('pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 text-xs shadow-lg backdrop-blur', LEVEL_STYLES[toast.level])}
          role="status"
        >
          <div className="mt-0.5">{LEVEL_ICONS[toast.level]}</div>
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{toast.title}</p>
            {toast.message ? <p className="mt-0.5 break-words text-[11px] opacity-90">{toast.message}</p> : null}
          </div>
          <button type="button" className="opacity-60 transition-opacity hover:opacity-100" onClick={() => dismissToast(toast.id)} aria-label="Dismiss">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
