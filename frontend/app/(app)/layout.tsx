"use client";

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/layout/app-shell';
import { useTerminal } from '@/lib/terminal-context';
import { Skeleton } from '@/components/ui/skeleton';

/** Authenticated shell — redirects to /login when there is no valid session. */
export default function TerminalLayout({ children }: { children: ReactNode }): JSX.Element {
  const router = useRouter();
  const { ready, authenticated } = useTerminal();

  useEffect(() => {
    if (ready && !authenticated) router.replace('/login');
  }, [authenticated, ready, router]);

  if (!ready || !authenticated) {
    return (
      <div className="flex h-dvh items-center justify-center bg-background">
        <div className="w-72 space-y-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </div>
    );
  }

  return <AppShell>{children}</AppShell>;
}
