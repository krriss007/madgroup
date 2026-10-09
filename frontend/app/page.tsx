"use client";

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useTerminal } from '@/lib/terminal-context';
import { Skeleton } from '@/components/ui/skeleton';

/** Entry point — routes to the terminal or the sign-in page. */
export default function IndexPage(): JSX.Element {
  const router = useRouter();
  const { ready, authenticated } = useTerminal();

  useEffect(() => {
    if (!ready) return;
    router.replace(authenticated ? '/dashboard' : '/login');
  }, [authenticated, ready, router]);

  return (
    <div className="flex h-dvh items-center justify-center bg-background">
      <div className="w-64 space-y-2">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    </div>
  );
}
