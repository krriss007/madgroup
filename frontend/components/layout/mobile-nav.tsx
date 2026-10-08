"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CandlestickChart, LayoutDashboard, ListOrdered, PlusCircle, Settings } from "lucide-react";
import { cn } from "@/lib/utils";

const ITEMS = [
  { href: "/dashboard", label: "Dashboard", icon: <LayoutDashboard className="h-4 w-4" /> },
  { href: "/markets/xauusd", label: "Chart", icon: <CandlestickChart className="h-4 w-4" /> },
  { href: "/positions", label: "Positions", icon: <ListOrdered className="h-4 w-4" /> },
  { href: "/orders", label: "Orders", icon: <PlusCircle className="h-4 w-4" /> },
  { href: "/settings", label: "Settings", icon: <Settings className="h-4 w-4" /> },
];

export function MobileNav(): JSX.Element {
  const pathname = usePathname();
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-panel-border bg-panel/95 backdrop-blur lg:hidden">
      {ITEMS.map((item) => {
        const active = pathname === item.href || pathname?.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn("flex flex-1 flex-col items-center gap-1 py-2 text-[10px] text-muted-foreground", active && "text-primary")}
          >
            {item.icon}
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
