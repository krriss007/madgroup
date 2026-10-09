"use client";

/** Equity curve rendered from recorded portfolio snapshots (no invented data). */

import { useEffect, useMemo, useRef } from 'react';
import { ColorType, createChart, LineStyle, type UTCTimestamp } from 'lightweight-charts';

export interface EquityPoint {
  time: string;
  balance: number;
  equity: number;
}

export function AccountEquityChart({ points, height = 220 }: { points: EquityPoint[]; height?: number }): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);

  const data = useMemo(
    () =>
      points
        .map((point) => ({ time: Math.floor(Date.parse(point.time) / 1000), balance: point.balance, equity: point.equity }))
        .filter((point) => Number.isFinite(point.time))
        .sort((a, b) => a.time - b.time),
    [points],
  );

  useEffect(() => {
    if (!ref.current) return undefined;
    const chart = createChart(ref.current, {
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#7c8ba1", fontSize: 10 },
      grid: { vertLines: { color: "rgba(148,163,184,0.06)" }, horzLines: { color: "rgba(148,163,184,0.06)" } },
      rightPriceScale: { borderColor: "rgba(148,163,184,0.1)" },
      timeScale: { borderColor: "rgba(148,163,184,0.1)", timeVisible: true, secondsVisible: false },
      autoSize: true,
    });

    const equitySeries = chart.addAreaSeries({
      lineColor: "#38bdf8",
      topColor: "rgba(56,189,248,0.25)",
      bottomColor: "rgba(56,189,248,0.02)",
      lineWidth: 2,
      priceLineVisible: false,
    });
    const balanceSeries = chart.addLineSeries({
      color: "#a78bfa",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
    });

    equitySeries.setData(data.map((point) => ({ time: point.time as UTCTimestamp, value: point.equity })));
    balanceSeries.setData(data.map((point) => ({ time: point.time as UTCTimestamp, value: point.balance })));
    chart.timeScale().fitContent();

    return () => chart.remove();
  }, [data]);

  if (data.length < 2) {
    return (
      <div className="flex h-[220px] items-center justify-center rounded border border-panel-border/60 bg-background/30 text-2xs text-muted-foreground">
        Equity curve appears after a few portfolio snapshots have been recorded.
      </div>
    );
  }

  return (
    <div>
      <div ref={ref} style={{ height }} />
      <p className="px-2 pb-1 text-[10px] text-muted-foreground">
        <span className="text-sky-300">■</span> equity · <span className="text-violet-300">▬</span> balance — built from recorded account snapshots.
      </p>
    </div>
  );
}
