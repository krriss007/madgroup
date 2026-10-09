"use client";

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Bell,
  BookOpenText,
  CandlestickChart,
  Calculator,
  Coins,
  FileClock,
  Gauge,
  LayoutDashboard,
  ListOrdered,
  Settings,
  Star,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export interface NavItem {
  href: string;
  label: string;
  icon: JSX.Element;
  badge?: string;
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: <LayoutDashboard className="h-4 w-4" /> },
  { href: '/markets', label: 'Markets', icon: <CandlestickChart className="h-4 w-4" /> },
  { href: '/markets/xauusd', label: 'XAU/USD', icon: <Coins className="h-4 w-4" /> },
  { href: '/markets/forex', label: 'Forex', icon: <Gauge className="h-4 w-4" /> },
  { href: '/positions', label: 'Positions', icon: <ListOrdered className="h-4 w-4" /> },
  { href: '/orders', label: 'Pending Orders', icon: <FileClock className="h-4 w-4" /> },
  { href: '/history', label: 'Trade History', icon: <BookOpenText className="h-4 w-4" /> },
  { href: '/watchlist', label: 'Watchlist', icon: <Star className="h-4 w-4" /> },
  { href: '/risk-calculator', label: 'Risk Calculator', icon: <Calculator className="h-4 w-4" /> },
  { href: '/journal', label: 'Trading Journal', icon: <BookOpenText className="h-4 w-4" /> },
  { href: '/analytics', label: 'Analytics', icon: <Gauge className="h-4 w-4" /> },
  { href: '/alerts', label: 'Price Alerts', icon: <Bell className="h-4 w-4" /> },
  { href: '/settings', label: 'Settings', icon: <Settings className="h-4 w-4" /> },
];

export function SidebarNav({ onNavigate }: { onNavigate?: () => void }): JSX.Element {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-0.5 px-2 py-2">
      {NAV_ITEMS.map((item) => {
        const active = pathname === item.href || (item.href !== '/dashboard' && pathname?.startsWith(`${item.href}/`));
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={cn(
              'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
              active && 'bg-accent text-foreground',
            )}
          >
            <span className={cn('text-muted-foreground', active && 'text-primary')}>{item.icon}</span>
            <span className="truncate">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
