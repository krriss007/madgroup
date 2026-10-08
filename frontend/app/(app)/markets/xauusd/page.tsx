"use client";

import { SymbolTerminal } from '@/components/terminal/symbol-terminal';

/** XAU/USD — the primary trading screen (left market watch, chart, order panel, positions/orders/history). */
export default function XauusdPage(): JSX.Element {
  return <SymbolTerminal requested="XAUUSD" />;
}
