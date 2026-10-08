"use client";

import { useState } from 'react';
import { Ban, PowerOff, ShieldAlert, XCircle } from 'lucide-react';
import { useTerminal } from '@/lib/terminal-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CLOSE_ALL_CONFIRMATION } from '@/lib/constants';

/**
 * Emergency controls. Every destructive action requires an explicit
 * confirmation step; CLOSE ALL POSITIONS additionally requires the exact
 * confirmation phrase, exactly as specified for this platform.
 */
export function EmergencyControls(): JSX.Element {
  const { mode, positions, orders, liveTradingEnabled, closeAllPositions, cancelAllOrders, disableLiveTrading, closePosition } = useTerminal();
  const [open, setOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [cancelConfirm, setCancelConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  const isLive = mode === 'LIVE';
  const singlePosition = positions.length === 1 ? positions[0] : null;

  const runCloseAll = async (): Promise<void> => {
    setBusy(true);
    try {
      await closeAllPositions(confirmText);
      setOpen(false);
      setConfirmText('');
    } finally {
      setBusy(false);
    }
  };

  const runCancelAll = async (): Promise<void> => {
    setBusy(true);
    try {
      await cancelAllOrders(isLive ? cancelConfirm : '');
      setCancelOpen(false);
      setCancelConfirm('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={isLive ? 'panel border-rose-500/40 p-3' : 'panel p-3'}>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <ShieldAlert className={isLive ? 'h-3.5 w-3.5 text-rose-400' : 'h-3.5 w-3.5'} />
          Emergency controls
        </span>
        {isLive ? <span className="text-2xs font-semibold uppercase text-rose-300">live · real money</span> : <span className="text-2xs text-muted-foreground">demo · simulated</span>}
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <Button
          variant="destructive"
          size="sm"
          disabled={!singlePosition}
          onClick={() => {
            if (singlePosition) void closePosition(singlePosition.ticket, { confirm: 'CLOSE' });
          }}
          title={singlePosition ? `Close ${singlePosition.ticket}` : 'Available when exactly one position is open'}
        >
          <XCircle className="h-3.5 w-3.5" /> Close current position
        </Button>

        <Button variant="destructive" size="sm" onClick={() => setOpen(true)} disabled={positions.length === 0}>
          <Ban className="h-3.5 w-3.5" /> Close all positions ({positions.length})
        </Button>

        <Button variant="destructive" size="sm" onClick={() => setCancelOpen(true)} disabled={orders.length === 0}>
          <XCircle className="h-3.5 w-3.5" /> Cancel all pending ({orders.length})
        </Button>

        <Button variant="outline" size="sm" onClick={() => setDisableOpen(true)} disabled={!liveTradingEnabled}>
          <PowerOff className="h-3.5 w-3.5" /> Disable live trading
        </Button>
      </div>

      <p className="mt-2 text-2xs text-muted-foreground">
        {isLive
          ? 'These controls send signed commands to your MT5 terminal. Nothing is executed until the terminal confirms it.'
          : 'These controls act on your simulated demo account only.'}
      </p>

      {/* CLOSE ALL confirmation ------------------------------------------ */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className={isLive ? 'border-rose-500/50' : undefined}>
          <DialogHeader>
            <DialogTitle className="text-rose-300">
              {isLive ? 'Are you sure you want to close ALL live positions?' : 'Close all demo positions?'}
            </DialogTitle>
            <DialogDescription>
              {isLive
                ? `This will market-close ${positions.length} live position(s) at the broker's current prices. Losses are realised immediately. Type ${CLOSE_ALL_CONFIRMATION} to confirm.`
                : `This will close ${positions.length} simulated position(s) at the demo market price and realise the P/L. Type ${CLOSE_ALL_CONFIRMATION} to confirm.`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="confirm-close-all">Confirmation text</Label>
            <Input
              id="confirm-close-all"
              value={confirmText}
              onChange={(event) => setConfirmText(event.target.value.toUpperCase())}
              placeholder={CLOSE_ALL_CONFIRMATION}
              autoComplete="off"
              className="num"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={confirmText.trim() !== CLOSE_ALL_CONFIRMATION || busy} onClick={() => void runCloseAll()}>
              {busy ? 'Closing…' : isLive ? 'CONFIRM CLOSE ALL (LIVE)' : 'CONFIRM CLOSE ALL (DEMO)'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* CANCEL ALL confirmation ---------------------------------------- */}
      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel all pending orders?</DialogTitle>
            <DialogDescription>
              {isLive
                ? `All ${orders.length} live pending order(s) will be removed from your MT5 terminal. Type CANCEL ALL PENDING ORDERS to confirm.`
                : `All ${orders.length} simulated pending order(s) will be cancelled.`}
            </DialogDescription>
          </DialogHeader>
          {isLive ? (
            <div className="space-y-1">
              <Label htmlFor="confirm-cancel-all">Confirmation text</Label>
              <Input
                id="confirm-cancel-all"
                value={cancelConfirm}
                onChange={(event) => setCancelConfirm(event.target.value.toUpperCase())}
                placeholder="CANCEL ALL PENDING ORDERS"
                className="num"
              />
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCancelOpen(false)} disabled={busy}>
              Keep orders
            </Button>
            <Button
              variant="destructive"
              disabled={(isLive && cancelConfirm.trim() !== 'CANCEL ALL PENDING ORDERS') || busy}
              onClick={() => void runCancelAll()}
            >
              Cancel all orders
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* DISABLE LIVE confirmation -------------------------------------- */}
      <Dialog open={disableOpen} onOpenChange={setDisableOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disable live trading?</DialogTitle>
            <DialogDescription>
              New live orders will be rejected immediately. Open positions stay with your broker — use “Close all positions” if you also want to flatten them.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDisableOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                void disableLiveTrading('Emergency switch used from the terminal UI.');
                setDisableOpen(false);
              }}
            >
              Disable live trading
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
