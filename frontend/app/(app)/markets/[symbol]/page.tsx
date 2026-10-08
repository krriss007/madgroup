"use client";

import { useParams } from 'next/navigation';
import { SymbolTerminal } from '@/components/terminal/symbol-terminal';

/** Instrument trading screen for any symbol the broker provides. */
export default function SymbolPage(): JSX.Element {
  const params = useParams<{ symbol: string }>();
  const requested = decodeURIComponent(String(params?.symbol ?? 'XAUUSD')).toUpperCase();
  return <SymbolTerminal requested={requested} />;
}
