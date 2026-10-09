/**
 * Converters between broker/EA payloads and the shared domain model.
 *
 * Keeping this in one place guarantees that the frontend sees exactly the same
 * shape whether the data came from the built-in demo engine or from a live MT5
 * terminal — the only difference the UI renders is the `source` field.
 */

import { canonicalize, instrumentCategory, round } from '@tradepilot/shared';
import type { Candle, Quote, SymbolInfo } from '@tradepilot/shared';
import type { EaSymbolPayload, EaTickPayload, EaRatePayload } from '@tradepilot/shared';
import type { SimulatedQuote } from '../demo/market-simulator';

export function simulatedQuoteToSymbolInfo(quote: SimulatedQuote): SymbolInfo {
  return {
    symbol: quote.symbol,
    canonical: quote.canonical,
    description: quote.description,
    category: instrumentCategory(quote.symbol),
    currencyBase: canonicalize(quote.symbol).slice(0, 3),
    currencyProfit: quote.currencyProfit,
    currencyMargin: quote.currencyProfit,
    digits: quote.digits,
    point: quote.point,
    tickSize: quote.tickSize,
    tickValue: quote.tickValue,
    tickValueProfit: quote.tickValueProfit,
    tickValueLoss: quote.tickValueLoss,
    contractSize: quote.contractSize,
    volumeMin: quote.volumeMin,
    volumeMax: quote.volumeMax,
    volumeStep: quote.volumeStep,
    stopsLevel: quote.stopsLevel,
    freezeLevel: 0,
    tradeMode: 4,
    tradeAllowed: quote.marketOpen,
    swapLong: quote.swapLongPerLot,
    swapShort: quote.swapShortPerLot,
    sessions: quote.sessions,
    updatedAt: new Date().toISOString(),
    source: 'DEMO_SIMULATED',
  };
}

export function simulatedQuoteToQuote(quote: SimulatedQuote): Quote {
  return {
    symbol: quote.symbol,
    canonical: quote.canonical,
    bid: quote.bid,
    ask: quote.ask,
    spread: quote.spread,
    spreadPoints: quote.spreadPoints,
    digits: quote.digits,
    high: quote.high,
    low: quote.low,
    open: quote.open,
    close: quote.close,
    changePercent: quote.changePercent,
    time: new Date(quote.time).toISOString(),
    source: 'DEMO_SIMULATED',
  };
}

export function eaSymbolToSymbolInfo(payload: EaSymbolPayload): SymbolInfo {
  return {
    symbol: payload.symbol,
    canonical: canonicalize(payload.symbol),
    description: payload.description || payload.symbol,
    category: instrumentCategory(payload.symbol),
    currencyBase: payload.currency_base,
    currencyProfit: payload.currency_profit,
    currencyMargin: payload.currency_margin,
    digits: payload.digits,
    point: payload.point,
    tickSize: payload.tick_size || payload.point,
    tickValue: payload.tick_value,
    tickValueProfit: payload.tick_value_profit,
    tickValueLoss: payload.tick_value_loss,
    contractSize: payload.contract_size,
    volumeMin: payload.volume_min,
    volumeMax: payload.volume_max,
    volumeStep: payload.volume_step,
    stopsLevel: payload.stops_level,
    freezeLevel: payload.freeze_level,
    tradeMode: payload.trade_mode,
    tradeAllowed: payload.trade_allowed,
    swapLong: payload.swap_long,
    swapShort: payload.swap_short,
    sessions: payload.sessions ?? [],
    updatedAt: new Date().toISOString(),
    source: 'MT5',
  };
}

export interface LiveQuoteState {
  bid: number;
  ask: number;
  spreadPoints: number;
  high: number;
  low: number;
  open: number;
  time: number;
  /** optional: computed from open when missing */
  changePercent?: number;
}

export function eaTickToQuote(_tick: EaTickPayload, state: LiveQuoteState, symbol: SymbolInfo): Quote {
  const spread = round(Math.max(0, state.ask - state.bid), symbol.digits);
  const changePercent =
    state.changePercent ?? (state.open ? round(((state.ask - state.open) / state.open) * 100, 3) : 0);
  return {
    symbol: symbol.symbol,
    canonical: symbol.canonical,
    bid: state.bid,
    ask: state.ask,
    spread,
    spreadPoints: symbol.point > 0 ? round(spread / symbol.point, 1) : state.spreadPoints,
    digits: symbol.digits,
    high: state.high,
    low: state.low,
    open: state.open,
    close: state.bid,
    changePercent,
    time: new Date(state.time).toISOString(),
    source: 'MT5',
  };
}

export function eaRatesToCandles(payload: EaRatePayload): Candle[] {
  return payload.rates
    .map((rate) => ({
      time: Math.floor(Date.parse(rate.time) / 1000),
      open: rate.open,
      high: rate.high,
      low: rate.low,
      close: rate.close,
      volume: rate.volume,
    }))
    .filter((candle) => Number.isFinite(candle.time))
    .sort((a, b) => a.time - b.time);
}
