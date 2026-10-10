// ---------------------------------------------------------------------------
// Minimal backtester for the same example strategy, over CLOSED candles of
// the selected market/timeframe. Results are explicitly HYPOTHETICAL: they
// use clearly-labelled data (sample or public history), fixed bps fees and
// slippage, and a conservative intra-bar rule (if SL and TP are both touched
// within one candle, the STOP is assumed to fill first).
//
// No lookahead: a signal on candle i is filled at candle i+1's open.
// ---------------------------------------------------------------------------
import { evaluateStrategy } from './strategy.js';

const BPS = 10_000;
const round8 = (x) => Math.round(x * 1e8) / 1e8;
const round2 = (x) => Math.round(x * 100) / 100;

export function runBacktest({ candles, config, startBalance = 10000 }) {
  const cfg = config;
  const warmup = Math.max(cfg.slowEma, cfg.rsiPeriod, cfg.atrPeriod) + 2;
  if (candles.length <= warmup + 2) {
    return { error: 'Not enough closed candles for a backtest - pick a longer window.' };
  }

  let cash = startBalance;
  let pos = null;
  const trades = [];
  const equityCurve = [{ t: candles[warmup].t, equity: round2(cash) }];

  const feeRate = cfg.feeBps / BPS;
  const slipRate = cfg.slippageBps / BPS;

  for (let i = warmup; i < candles.length; i++) {
    const bar = candles[i];

    // ---- exits first (evaluated on this bar's range) ----
    if (pos) {
      let exit = null;
      if (pos.side === 'LONG') {
        if (bar.l <= pos.stopLoss) exit = { price: pos.stopLoss, reason: 'STOP_LOSS' };
        else if (bar.h >= pos.takeProfit) exit = { price: pos.takeProfit, reason: 'TAKE_PROFIT' };
      } else {
        if (bar.h >= pos.stopLoss) exit = { price: pos.stopLoss, reason: 'STOP_LOSS' };
        else if (bar.l <= pos.takeProfit) exit = { price: pos.takeProfit, reason: 'TAKE_PROFIT' };
      }
      if (!exit && i === candles.length - 1) {
        exit = { price: bar.c, reason: 'END_OF_DATA' };
      }
      if (exit) {
        // Assume the exit level fills exactly (no slippage on resting orders
        // in this simple model) - fees still apply.
        const gross = pos.side === 'LONG'
          ? (exit.price - pos.entryPrice) * pos.qty
          : (pos.entryPrice - exit.price) * pos.qty;
        const feeExit = pos.qty * exit.price * feeRate;
        const net = gross - pos.feeEntry - feeExit;
        cash += net;
        trades.push({
          symbol: pos.symbol, side: pos.side, qty: pos.qty,
          entryPrice: pos.entryPrice, exitPrice: exit.price,
          entryTime: pos.entryTime, exitTime: bar.t,
          grossPnl: round8(gross), fees: round8(pos.feeEntry + feeExit),
          netPnl: round8(net), exitReason: exit.reason,
        });
        pos = null;
      }
    }

    // ---- entries on the NEXT bar's open (no lookahead) ----
    if (!pos && i + 1 < candles.length) {
      const closedSoFar = candles.slice(0, i + 1);
      const ev = evaluateStrategy(closedSoFar, cfg);
      const next = candles[i + 1];
      const entry = ev.action === 'BUY' ? next.o * (1 + slipRate) : null;
      if (entry != null) {
        const equityNow = cash;
        const notional = (equityNow * cfg.positionSizePct) / 100;
        const qty = notional / entry;
        pos = {
          symbol: 'N/A (backtest)', side: 'LONG', qty,
          entryPrice: entry, entryTime: next.t,
          stopLoss: ev.levels.stopLoss, takeProfit: ev.levels.takeProfit,
          feeEntry: notional * feeRate,
          slippageEntry: (entry - next.o) * qty,
        };
      }
      void bar;
    }

    // Mark-to-market the open position at this bar's close for the curve.
    equityCurve.push({ t: bar.t, equity: round2(cash + (pos ? pos.qty * bar.c : 0)) });
  }

  // ---- stats ----
  const netPnl = trades.reduce((a, t) => a + t.netPnl, 0);
  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl <= 0);
  let peak = startBalance;
  let maxDD = 0;
  for (const p of equityCurve) {
    peak = Math.max(peak, p.equity);
    maxDD = Math.max(maxDD, (peak - p.equity) / peak);
  }
  const grossWin = wins.reduce((a, t) => a + t.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.netPnl, 0));

  return {
    hypothetical: true,
    barsTested: candles.length - warmup,
    tradesCount: trades.length,
    stats: {
      netPnl: round2(netPnl),
      netPnlPct: round2((netPnl / startBalance) * 100),
      winRatePct: trades.length ? round2((wins.length / trades.length) * 100) : null,
      profitFactor: grossLoss > 0 ? round2(grossWin / grossLoss) : null,
      maxDrawdownPct: round2(maxDD * 100),
      feesTotal: round2(trades.reduce((a, t) => a + t.fees, 0)),
      avgWin: wins.length ? round2(grossWin / wins.length) : null,
      avgLoss: losses.length ? round2(-grossLoss / losses.length) : null,
      startBalance: round2(startBalance),
      endEquity: round2(startBalance + netPnl),
    },
    trades: trades.slice(-50).reverse(),
    equityCurve,
  };
}
