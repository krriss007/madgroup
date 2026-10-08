"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertOctagon,
  Bell,
  Check,
  ChevronDown,
  LogOut,
  Radio,
  ShieldCheck,
  TrendingUp,
  WifiOff,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { formatMoney, formatNumber, relativeTime } from "@tradepilot/shared";
import { useTerminal } from "@/lib/terminal-context";
import { cn } from "@/lib/utils";

export function TopBar({ onOpenMobileNav }: { onOpenMobileNav?: () => void }): JSX.Element {
  const { account, connection, mode, setMode, liveTradingEnabled, notifications, unreadNotifications, markNotificationsRead, logout, session, realtimeConnected } = useTerminal();
  const [notificationsOpen, setNotificationsOpen] = useState(false);

  const currency = account?.currency ?? "USD";
  const online = connection.status === "CONNECTED";
  const latencyMs = connection.mt5?.latencyMs ?? null;
  const stats = [
    { label: "Balance", value: formatMoney(account?.balance ?? null, currency) },
    { label: "Equity", value: formatMoney(account?.equity ?? null, currency) },
    { label: "Free Margin", value: formatMoney(account?.freeMargin ?? null, currency) },
    { label: "Margin Level", value: account?.marginLevel != null ? `${formatNumber(account.marginLevel, 2)}%` : "—" },
  ];

  return (
    <header className="z-40 flex h-14 shrink-0 items-center gap-3 border-b border-panel-border bg-panel/90 px-3 backdrop-blur">
      <button type="button" onClick={onOpenMobileNav} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent lg:hidden" aria-label="Open navigation">
        <Activity className="h-4 w-4" />
      </button>

      <Link href="/dashboard" className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/15 text-primary">
          <TrendingUp className="h-4 w-4" />
        </span>
        <span className="hidden flex-col leading-none sm:flex">
          <span className="text-sm font-semibold tracking-tight">TradePilot</span>
          <span className="text-2xs text-muted-foreground">XAU/USD &amp; Forex terminal</span>
        </span>
      </Link>

      <div className="mx-1 hidden h-8 w-px bg-panel-border sm:block" />

      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className={cn("flex items-center gap-1.5 rounded-md border px-2 py-1 text-2xs font-semibold uppercase", online ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-rose-500/40 bg-rose-500/10 text-rose-300")}>
              <span className={cn("h-1.5 w-1.5 rounded-full", online ? "animate-pulse-dot bg-emerald-400" : "bg-rose-400")} />
              {online ? "MT5 CONNECTED" : "MT5 DISCONNECTED"}
              {latencyMs != null && online ? <span className="ml-1 font-normal text-emerald-200/70">{latencyMs}ms</span> : null}
            </div>
          </TooltipTrigger>
          <TooltipContent>
            {online ? (
              <div className="space-y-0.5">
                <p>Account: {connection.mt5?.accountLogin ?? "—"}</p>
                <p>Server: {connection.mt5?.server ?? "—"}</p>
                <p>Latency: {latencyMs ?? "—"} ms</p>
                <p>Last heartbeat: {relativeTime(connection.mt5?.lastHeartbeat ?? null)}</p>
                <p>Algo trading: {connection.mt5?.algoTradingEnabled ? "enabled" : "disabled"}</p>
              </div>
            ) : (
              <div className="space-y-0.5">
                <p>No MT5 terminal is connected.</p>
                <p>Live prices and live trading are unavailable.</p>
                <p>Demo trading continues to work normally.</p>
              </div>
            )}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <div className="flex items-center gap-1 rounded-md border border-panel-border bg-background/60 p-0.5">
        {(["DEMO", "LIVE"] as const).map((candidate) => (
          <button
            key={candidate}
            type="button"
            onClick={() => void setMode(candidate)}
            className={cn(
              "rounded px-2 py-0.5 text-2xs font-semibold uppercase tracking-wide transition-colors",
              mode === candidate ? (candidate === "LIVE" ? "bg-rose-600 text-white" : "bg-sky-600 text-white") : "text-muted-foreground hover:text-foreground",
            )}
          >
            {candidate}
          </button>
        ))}
      </div>

      {mode === "LIVE" && liveTradingEnabled ? (
        <Badge variant="live" className="animate-pulse-dot">
          <AlertOctagon className="h-3 w-3" /> 🔴 LIVE TRADING
        </Badge>
      ) : null}
      {mode === "LIVE" && !liveTradingEnabled ? (
        <Badge variant="outline">
          <ShieldCheck className="h-3 w-3" /> LIVE locked
        </Badge>
      ) : null}

      <div className="ml-auto hidden items-center gap-4 xl:flex">
        {stats.map((stat) => (
          <div key={stat.label} className="flex flex-col leading-none">
            <span className="text-2xs uppercase tracking-wide text-muted-foreground">{stat.label}</span>
            <span className="num text-sm text-foreground">{stat.value}</span>
          </div>
        ))}
      </div>

      <div className="ml-auto flex items-center gap-2 xl:ml-3">
        <span className={cn("hidden items-center gap-1 text-2xs sm:flex", realtimeConnected ? "text-emerald-300" : "text-amber-300")}>
          {realtimeConnected ? <Radio className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
          {realtimeConnected ? "stream" : "offline"}
        </span>

        <DropdownMenu open={notificationsOpen} onOpenChange={setNotificationsOpen}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="relative" aria-label="Notifications">
              <Bell className="h-4 w-4" />
              {unreadNotifications > 0 ? (
                <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-bold text-primary-foreground">
                  {unreadNotifications > 9 ? "9+" : unreadNotifications}
                </span>
              ) : null}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-80">
            <div className="flex items-center justify-between px-2 py-1">
              <DropdownMenuLabel className="p-0">Notifications</DropdownMenuLabel>
              <button
                type="button"
                className="text-2xs text-primary hover:underline"
                onClick={() => {
                  void markNotificationsRead();
                }}
              >
                Mark all read
              </button>
            </div>
            <DropdownMenuSeparator />
            <ScrollArea className="max-h-80">
              {notifications.length === 0 ? (
                <p className="px-2 py-4 text-center text-2xs text-muted-foreground">No notifications yet.</p>
              ) : (
                notifications.slice(0, 25).map((notification) => (
                  <DropdownMenuItem key={notification.id} className="flex-col items-start gap-0.5 py-2">
                    <span className="flex w-full items-center gap-1.5 text-xs font-medium">
                      <span
                        className={cn(
                          "h-1.5 w-1.5 rounded-full",
                          notification.level === "critical" || notification.level === "warning" ? "bg-amber-400" : notification.level === "success" ? "bg-emerald-400" : "bg-sky-400",
                        )}
                      />
                      {notification.title}
                    </span>
                    <span className="text-[11px] text-muted-foreground">{notification.message}</span>
                    <span className="text-2xs text-muted-foreground/70">{relativeTime(notification.createdAt)}</span>
                  </DropdownMenuItem>
                ))
              )}
            </ScrollArea>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-secondary text-2xs font-semibold uppercase">
                {(session?.user.displayName ?? "TP").slice(0, 2)}
              </span>
              <span className="hidden max-w-28 truncate text-xs sm:inline">{session?.user.displayName ?? "Trader"}</span>
              <ChevronDown className="h-3 w-3 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="normal-case text-muted-foreground">
              <span className="block text-xs text-foreground">{session?.user.email}</span>
              <span className="block text-2xs">{account?.login} • {account?.server}</span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/settings">Account &amp; risk settings</Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/settings/mt5">MT5 connection</Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled className="text-2xs">
              <Check className="h-3 w-3 text-emerald-400" /> Sessions secured with httpOnly cookies
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-rose-300"
              onClick={() => {
                void logout();
              }}
            >
              <LogOut className="h-3 w-3" /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
