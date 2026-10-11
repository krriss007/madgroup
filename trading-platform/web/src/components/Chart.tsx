import { useEffect, useRef } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Bar, PendingOrder, PositionView, Timeframe } from '../../../shared/types';

interface Props {
  symbol: string;
  tf: Timeframe;
  digits: number;
  bar: { symbol: string; tf: Timeframe; bar: Bar } | null;
  positions: PositionView[];
  pending: PendingOrder[];
}

/** Candlestick chart with live forming candle and position / order price lines. */
/**
 * Explicit price formatter. The built-in 'price' type rendered FX axes with bogus
 * labels (e.g. 1.99998 for 1.0974) at 5 decimals, so format with toFixed instead.
 */
function priceFormatFor(digits: number) {
  return {
    type: 'custom' as const,
    minMove: Math.pow(10, -digits),
    formatter: (price: number) => (Number.isFinite(price) ? price.toFixed(digits) : ''),
  };
}

export function Chart({ symbol, tf, digits, bar, positions, pending }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);
  const lastTimeRef = useRef<number>(0);

  // Create the chart once.
  useEffect(() => {
    const el = containerRef.current!;
    const chart = createChart(el, {
      autoSize: true,
      // Pin the locale: browsers can report non-standard tags (e.g. "en-US@posix"),
      // which make the chart's Intl formatting throw and leave the canvas blank.
      localization: { locale: 'en-US' },
      layout: {
        background: { type: ColorType.Solid, color: '#0c1118' },
        textColor: '#8b97a8',
        fontFamily: 'Inter, system-ui, sans-serif',
      },
      grid: { vertLines: { color: '#152031' }, horzLines: { color: '#152031' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#1d2a3c' },
      timeScale: { borderColor: '#1d2a3c', timeVisible: true, secondsVisible: false },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#2bb673',
      downColor: '#e5484d',
      borderVisible: false,
      wickUpColor: '#2bb673',
      wickDownColor: '#e5484d',
      priceFormat: priceFormatFor(digits),
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      linesRef.current = [];
    };
    // digits is applied in the symbol effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load history when symbol / timeframe changes.
  useEffect(() => {
    let cancelled = false;
    const series = seriesRef.current;
    if (!series) return;
    series.applyOptions({ priceFormat: priceFormatFor(digits) });
    fetch(`/api/bars?symbol=${encodeURIComponent(symbol)}&tf=${tf}&limit=500`)
      .then((r) => r.json())
      .then((json: { ok: boolean; data: Bar[] }) => {
        if (cancelled || !json.ok) return;
        const data = json.data.map((b) => ({
          time: (b.t / 1000) as UTCTimestamp,
          open: b.o,
          high: b.h,
          low: b.l,
          close: b.c,
        }));
        series.setData(data);
        lastTimeRef.current = data.length ? (data[data.length - 1]!.time as number) : 0;
        chartRef.current?.timeScale().fitContent();
      })
      .catch(() => {
        /* network hiccup: the next subscription will retry */
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, tf, digits]);

  // Forming candle updates pushed over WebSocket.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !bar || bar.symbol !== symbol || bar.tf !== tf) return;
    const time = (bar.bar.t / 1000) as UTCTimestamp;
    if (time < lastTimeRef.current) return;
    lastTimeRef.current = time as number;
    series.update({ time, open: bar.bar.o, high: bar.bar.h, low: bar.bar.l, close: bar.bar.c });
  }, [bar, symbol, tf]);

  // Price lines for the selected symbol's positions and pending orders.
  // Keyed on the actual levels so lines are only rebuilt when something moves.
  const levelsKey = JSON.stringify([
    positions.filter((p) => p.symbol === symbol).map((p) => [p.id, p.side, p.volume, p.openPrice, p.sl, p.tp]),
    pending.filter((o) => o.symbol === symbol).map((o) => [o.id, o.side, o.type, o.price]),
  ]);
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    for (const line of linesRef.current) series.removePriceLine(line);
    const lines: IPriceLine[] = [];
    const add = (price: number | null, color: string, title: string, style: LineStyle = LineStyle.Dashed) => {
      if (price === null || price === undefined) return;
      lines.push(series.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }));
    };
    for (const p of positions.filter((x) => x.symbol === symbol)) {
      add(p.openPrice, p.side === 'buy' ? '#4c9cf0' : '#f08a4c', `${p.side.toUpperCase()} ${p.volume}`, LineStyle.Solid);
      add(p.sl, '#e5484d', `SL #${p.id}`);
      add(p.tp, '#2bb673', `TP #${p.id}`);
    }
    for (const o of pending.filter((x) => x.symbol === symbol)) {
      add(o.price, '#e8b339', `${o.side === 'buy' ? 'BUY' : 'SELL'} ${o.type.toUpperCase()} #${o.id}`);
    }
    linesRef.current = lines;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levelsKey, symbol]);

  return <div ref={containerRef} className="chart" />;
}
