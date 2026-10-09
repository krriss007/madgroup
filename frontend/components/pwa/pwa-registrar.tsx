"use client";

import { useEffect } from "react";

/**
 * Registers the service worker that caches only the app shell.
 *
 * The worker deliberately never caches /api or /ws, so an offline terminal shows
 * "unavailable" and blocks trading instead of ever displaying a stale price.
 */
export function PwaRegistrar(): null {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* Offline shell is a progressive enhancement; the app works without it. */
    });
  }, []);
  return null;
}
