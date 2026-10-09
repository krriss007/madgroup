"use client";

import { useState, type ReactNode } from "react";
import { Toaster } from "./toaster";
import { TopBar } from "./top-bar";
import { SidebarNav } from "./sidebar-nav";
import { MobileNav } from "./mobile-nav";
import { PwaRegistrar } from "@/components/pwa/pwa-registrar";
import { OfflineBanner } from "@/components/pwa/offline-banner";
import { cn } from "@/lib/utils";

export function AppShell({ children }: { children: ReactNode }): JSX.Element {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      <PwaRegistrar />
      <TopBar onOpenMobileNav={() => setMobileNavOpen((open) => !open)} />
      <OfflineBanner />
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-52 shrink-0 border-r border-panel-border bg-panel/60 lg:block">
          <SidebarNav />
        </aside>
        {mobileNavOpen ? (
          <aside className="absolute inset-y-14 left-0 z-30 w-56 border-r border-panel-border bg-panel/95 backdrop-blur lg:hidden">
            <SidebarNav onNavigate={() => setMobileNavOpen(false)} />
          </aside>
        ) : null}
        <main className={cn("min-w-0 flex-1 overflow-y-auto pb-14 lg:pb-0")}>{children}</main>
      </div>
      <MobileNav />
      <Toaster />
    </div>
  );
}
