"use client";

import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";

/**
 * Honest offline state for a trading terminal.
 *
 * When the device drops its connection the app shell may still be visible
 * (thanks to the service worker), but live prices and order submission must be
 * unavailable. This banner states that plainly instead of letting a frozen quote
 * masquerade as the market.
 */
export function OfflineBanner(): JSX.Element | null {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  if (!offline) return null;

  return (
    <div role="alert" className="flex items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-amber-300">
      <WifiOff className="h-4 w-4 shrink-0" />
      <span className="text-2xs sm:text-xs">
        You&rsquo;re offline — live prices are unavailable and no orders can be placed until the connection returns.
      </span>
    </div>
  );
}
