"use client";

import { useEffect, useState } from "react";
import { Download, Share } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

/**
 * Native-app install affordance.
 *
 * Chrome/Edge/Android fire `beforeinstallprompt` — we capture it and replay on
 * tap. iOS Safari never fires it, so there we show the "Add to Home Screen"
 * instructions instead. Once running standalone, the button disappears.
 */
export function InstallAppButton(): JSX.Element | null {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [iosHelpOpen, setIosHelpOpen] = useState(false);
  const [isIOS, setIsIOS] = useState(false);

  useEffect(() => {
    setIsIOS(/iphone|ipad|ipod/i.test(navigator.userAgent));
    setInstalled(
      window.matchMedia("(display-mode: standalone)").matches ||
        (navigator as unknown as { standalone?: boolean }).standalone === true,
    );

    const onPrompt = (event: Event) => {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (installed) return null;

  const onClick = () => {
    if (deferred) {
      void deferred.prompt();
      setDeferred(null);
    } else {
      setIosHelpOpen(true);
    }
  };

  return (
    <>
      <Button variant="ghost" size="sm" onClick={onClick} aria-label="Install TradePilot as an app" className="gap-1.5">
        <Download className="h-4 w-4" />
        <span className="hidden md:inline">Install</span>
      </Button>
      <Dialog open={iosHelpOpen} onOpenChange={setIosHelpOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Install on iPhone / iPad</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>TradePilot runs full-screen like a native app on iOS:</p>
                <ol className="list-inside list-decimal space-y-1">
                  <li>
                    Tap the <Share className="inline h-3.5 w-3.5" /> Share button in Safari.
                  </li>
                  <li>Scroll and choose “Add to Home Screen”.</li>
                  <li>Tap Add — the app icon appears on your home screen.</li>
                </ol>
              </div>
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    </>
  );
}
