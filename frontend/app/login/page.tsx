"use client";

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, KeyRound, LockKeyhole, PlayCircle, ShieldCheck, TrendingUp } from 'lucide-react';
import { api, ApiError, enterDemoSession, loginWithPassword, suppressAutoLogin } from '@/lib/api';
import { useTerminal } from '@/lib/terminal-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';

/**
 * Sign-in page. Accounts live in the TradePilot database — never in the
 * browser. MT5 credentials are never requested here (or anywhere in the web
 * app): the MT5 bridge authenticates to the backend with a device token that
 * the user generates from Settings → MT5 Connection.
 */
export default function LoginPage(): JSX.Element {
  const router = useRouter();
  const { ready, authenticated, refresh } = useTerminal();
  const [email, setEmail] = useState('demo@tradepilot.local');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [demoAvailable, setDemoAvailable] = useState<boolean | null>(null);
  const [demoError, setDemoError] = useState<string | null>(null);

  useEffect(() => {
    if (ready && authenticated) router.replace('/dashboard');
  }, [authenticated, ready, router]);

  // Does this instance allow password-less demo entry? Ask the backend instead
  // of guessing from build-time config, and only show the affordance when true.
  useEffect(() => {
    let cancelled = false;
    void api
      .get<{ available: boolean }>('/auth/demo-session')
      .then((data) => {
        if (!cancelled) setDemoAvailable(Boolean(data.available));
      })
      .catch(() => {
        if (!cancelled) setDemoAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function enterDemo(): Promise<void> {
    setDemoBusy(true);
    setDemoError(null);
    try {
      const entry = await enterDemoSession();
      if (!entry) {
        setDemoError('Demo auto-entry is disabled on this instance. Sign in with your TradePilot account instead.');
        return;
      }
      suppressAutoLogin(false); // an explicit demo entry re-enables the fast path
      await refresh();
      router.replace('/dashboard');
    } catch (err) {
      setDemoError(err instanceof ApiError ? err.message : 'Could not open a demo session.');
    } finally {
      setDemoBusy(false);
    }
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      suppressAutoLogin(false);
      const { transport } = await loginWithPassword(email, password);
      setNotice(
        transport === 'bearer'
          ? 'This browser blocked the session cookie, so TradePilot is using a revocable session token for this tab instead. Everything else works normally.'
          : null,
      );
      await refresh();
      router.replace('/dashboard');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md space-y-4">
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/15 text-primary">
            <TrendingUp className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-lg font-semibold leading-none">TradePilot</h1>
            <p className="text-2xs text-muted-foreground">XAU/USD &amp; Forex trading terminal</p>
          </div>
        </div>

        {demoAvailable ? (
          <div className="panel space-y-2 border-emerald-500/30 p-4">
            <p className="text-2xs text-muted-foreground">
              This instance has <span className="text-foreground/90">DEMO auto-entry</span> enabled (
              <code className="text-foreground/80">DEMO_AUTO_LOGIN</code>): you can open the shared demo terminal — simulated $10,000 paper
              account, no real money — without typing anything.
            </p>
            <Button type="button" variant="secondary" className="w-full" onClick={() => void enterDemo()} disabled={demoBusy}>
              <PlayCircle className="h-4 w-4" />
              {demoBusy ? 'Opening demo terminal…' : 'Continue in DEMO mode (no password)'}
            </Button>
            {demoError ? <p className="text-2xs text-rose-200">{demoError}</p> : null}
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              LIVE trading is never unlocked by demo entry: it still requires your own authorized MT5 bridge connection, the explicit
              live-trading opt-in and the risk acknowledgement.
            </p>
          </div>
        ) : null}

        <form onSubmit={submit} className="panel space-y-3 p-4">
          <div className="space-y-1">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="your TradePilot password"
            />
          </div>

          {notice ? (
            <p className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-2xs text-amber-200">{notice}</p>
          ) : null}

          {error ? (
            <p className="flex items-start gap-1.5 rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1.5 text-2xs text-rose-200">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              {error}
            </p>
          ) : null}

          <Button type="submit" className="w-full" disabled={busy}>
            <KeyRound className="h-4 w-4" />
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>

          <p className="text-[10px] leading-relaxed text-muted-foreground">
            TradePilot asks for your <span className="text-foreground/80">TradePilot</span> account — it is not your MT5 login and not a broker
            password. A freshly seeded installation creates this demo user:
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 rounded border border-border/60 bg-muted/20 px-2 py-1.5 text-[10px]">
            <dt className="text-muted-foreground">Email</dt>
            <dd className="font-mono text-foreground/90">demo@tradepilot.local</dd>
            <dt className="text-muted-foreground">Password</dt>
            <dd className="font-mono text-foreground/90">demo1234</dd>
          </dl>
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            If that user was never seeded (or you already changed its password), register your own account with{' '}
            <code className="text-foreground/80">POST /api/v1/auth/register</code>, or set{' '}
            <code className="text-foreground/80">SEED_DEMO_USER=true</code> and restart the backend. Change the demo password in Settings and
            never reuse it anywhere else.
          </p>
        </form>

        <div className="panel space-y-2 p-3 text-2xs text-muted-foreground">
          <p className="flex items-center gap-1.5 text-foreground/90">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" /> Security notes
          </p>
          <p className="flex items-start gap-1.5">
            <LockKeyhole className="mt-0.5 h-3 w-3 shrink-0" />
            TradePilot never asks for, stores or transmits your MT5 password. The optional MT5 bridge uses a one-time device token
            (revocable at any time) that the EA sends to your own backend.
          </p>
          <p>
            TradePilot starts in <Badge variant="demo">DEMO</Badge> mode with simulated prices. Live trading against your own broker account
            must be enabled explicitly and is subject to your configured risk limits.
          </p>
        </div>
      </div>
    </div>
  );
}
