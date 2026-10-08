'use client';

/**
 * TradingChart — TradingView Lightweight Charts integration.
 *
 * • Chart types: candlestick, line, area (plus a volume histogram).
 * • Timeframes M1…W1 (data comes from the backend: the demo simulator in DEMO
 *   mode, the MT5 terminal through the EA in LIVE mode — never invented here).
 * • Indicators: EMA 9/20/50/100/200, Bollinger Bands, RSI, MACD, Stochastic,
 *   ATR. Overlays are drawn on the price pane; oscillators get their own
 *   synchronised pane below the chart (a lightweight-charts v4 limitation is
 *   that panes are separate chart instances).
 * • Crosshair, zoom and pan come from the library; a live price line and a
 *   countdown to the next candle close are added on top.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type LogicalRange,
  type UTCTimestamp,
} from 'lightweight-charts';
import {
  EMA_COLORS,
  INDICATOR_CATALOG,
  computeIndicators,
  type Candle,
  type IndicatorConfig,
  type IndicatorId,
  type Timeframe,
} from '@tradepilot/shared';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';

const TIMEFRAMES: Timeframe[] = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1'];
const CHART_TYPES = [
  { id: 'candlestick', label: 'Candles' },
  { id: 'line', label: 'Line' },
  { id: 'area', label: 'Area' },
] as const;

type ChartType = (typeof CHART_TYPES)[number]['id'];

const UP_COLOR = '#22c55e';
const DOWN_COLOR = '#ef4444';
const GRID_COLOR = 'rgba(148, 163, 184, 0.08)';
const TEXT_COLOR = '#7c8ba1';

export interface TradingChartProps {
  symbol: string;
  candles: Candle[];
  loading?: boolean;
  timeframe: Timeframe;
  onTimeframeChange: (timeframe: Timeframe) => void;
  chartType: ChartType;
  onChartTypeChange: (type: ChartType) => void;
  indicators: IndicatorConfig;
  onIndicatorsChange: (config: IndicatorConfig) => void;
  currentPrice?: number | null;
  priceDigits?: number;
  dataSource?: 'MT5' | 'DEMO_SIMULATED';
  showVolume?: boolean;
  onToggleVolume?: (value: boolean) => void;
  height?: number;
}

export function TradingChart({
  symbol,
  candles,
  loading,
  timeframe,
  onTimeframeChange,
  chartType,
  onChartTypeChange,
  indicators,
  onIndicatorsChange,
  currentPrice,
  priceDigits = 2,
  dataSource,
  showVolume = true,
  onToggleVolume,
  height = 460,
}: TradingChartProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceSeriesRef = useRef<ISeriesApi<'Candlestick'> | ISeriesApi<'Line'> | ISeriesApi<'Area'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const overlayRefs = useRef<ISeriesApi<'Line'>[]>([]);
  const priceLineRef = useRef<ReturnType<ISeriesApi<'Candlestick'>['createPriceLine']> | null>(null);
  const [ready, setReady] = useState(false);

  const computation = useMemo(() => computeIndicators(candles, indicators), [candles, indicators]);
  const paneIndicators = computation.panes;

  /* ----------------------------- main chart ---------------------------- */
  useEffect(() => {
    if (!containerRef.current) return undefined;
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: TEXT_COLOR,
        fontSize: 11,
      },
      grid: {
        vertLines: { color: GRID_COLOR },
        horzLines: { color: GRID_COLOR },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: 'rgba(148,163,184,0.4)', style: LineStyle.Dashed, labelBackgroundColor: '#1e293b' },
        horzLine: { color: 'rgba(148,163,184,0.4)', style: LineStyle.Dashed, labelBackgroundColor: '#1e293b' },
      },
      rightPriceScale: { borderColor: GRID_COLOR, scaleMargins: { top: 0.08, bottom: showVolume ? 0.24 : 0.08 } },
      timeScale: { borderColor: GRID_COLOR, timeVisible: true, secondsVisible: false, rightOffset: 6 },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
      autoSize: true,
    });
    chartRef.current = chart;
    setReady(true);

    const observer = new ResizeObserver(() => chart.applyOptions({}));
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      priceSeriesRef.current = null;
      volumeSeriesRef.current = null;
      overlayRefs.current = [];
      priceLineRef.current = null;
      setReady(false);
    };
  }, [showVolume]);

  /* -------------------------- price series data ------------------------ */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready) return;

    // Recreate the price series when the chart type changes.
    if (priceSeriesRef.current) {
      chart.removeSeries(priceSeriesRef.current);
      priceSeriesRef.current = null;
      priceLineRef.current = null;
    }

    const common = { priceLineVisible: true, lastValueVisible: true };
    const series =
      chartType === 'candlestick'
        ? chart.addCandlestickSeries({
            upColor: UP_COLOR,
            downColor: DOWN_COLOR,
            wickUpColor: UP_COLOR,
            wickDownColor: DOWN_COLOR,
            borderVisible: false,
            priceFormat: { type: 'price', precision: priceDigits, minMove: 10 ** -priceDigits },
            ...common,
          })
        : chartType === 'line'
          ? chart.addLineSeries({ color: '#38bdf8', lineWidth: 2, priceFormat: { type: 'price', precision: priceDigits, minMove: 10 ** -priceDigits }, ...common })
          : chart.addAreaSeries({
              lineColor: '#38bdf8',
              topColor: 'rgba(56,189,248,0.35)',
              bottomColor: 'rgba(56,189,248,0.02)',
              lineWidth: 2,
              priceFormat: { type: 'price', precision: priceDigits, minMove: 10 ** -priceDigits },
              ...common,
            });

    priceSeriesRef.current = series as never;

    if (candles.length) {
      if (chartType === 'candlestick') {
        (series as ISeriesApi<'Candlestick'>).setData(
          candles.map((candle) => ({
            time: candle.time as UTCTimestamp,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
          })),
        );
      } else {
        (series as ISeriesApi<'Line'>).setData(candles.map((candle) => ({ time: candle.time as UTCTimestamp, value: candle.close })));
      }
    }
  }, [chartType, candles, priceDigits, ready]);

  /* ----------------------------- volume -------------------------------- */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready) return;

    if (volumeSeriesRef.current) {
      chart.removeSeries(volumeSeriesRef.current);
      volumeSeriesRef.current = null;
    }
    if (!showVolume) return;

    const volume = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      color: 'rgba(56,189,248,0.35)',
    });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volume.setData(
      candles.map((candle) => ({
        time: candle.time as UTCTimestamp,
        value: candle.volume,
        color: candle.close >= candle.open ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.35)',
      })),
    );
    volumeSeriesRef.current = volume;
  }, [candles, showVolume, ready]);

  /* ---------------------------- overlays ------------------------------- */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ready) return;

    for (const series of overlayRefs.current) {
      try {
        chart.removeSeries(series);
      } catch {
        /* series already removed with the chart */
      }
    }
    overlayRefs.current = [];

    for (const overlay of computation.overlays) {
      if (!overlay.points.length) continue;
      const series = chart.addLineSeries({
        color: overlay.color,
        lineWidth: overlay.id.startsWith('bb-') ? 1 : 1,
        lineStyle: overlay.id.startsWith('bb-') ? LineStyle.Dotted : LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      series.setData(overlay.points.map((point) => ({ time: point.time as UTCTimestamp, value: point.value })));
      overlayRefs.current.push(series);
    }
  }, [computation.overlays, ready]);

  /* --------------------------- live price line ------------------------- */
  useEffect(() => {
    const series = priceSeriesRef.current;
    if (!series || !candles.length) return;
    const last = candles[candles.length - 1];
    if (chartType === 'candlestick') {
      (series as ISeriesApi<'Candlestick'>).update({
        time: last.time as UTCTimestamp,
        open: last.open,
        high: last.high,
        low: last.low,
        close: last.close,
      });
    } else {
      (series as ISeriesApi<'Line'>).update({ time: last.time as UTCTimestamp, value: last.close });
    }
    if (volumeSeriesRef.current) {
      volumeSeriesRef.current.update({
        time: last.time as UTCTimestamp,
        value: last.volume,
        color: last.close >= last.open ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.35)',
      });
    }
  }, [candles, chartType]);

  useEffect(() => {
    const series = priceSeriesRef.current;
    if (!series) return;
    if (priceLineRef.current) {
      try {
        series.removePriceLine(priceLineRef.current);
      } catch {
        /* ignore */
      }
      priceLineRef.current = null;
    }
    if (currentPrice == null || !Number.isFinite(currentPrice)) return;
    priceLineRef.current = series.createPriceLine({
      price: currentPrice,
      color: '#38bdf8',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: 'live',
    });
  }, [currentPrice]);

  const toggleIndicator = (id: IndicatorId): void => {
    const next: IndicatorConfig = {
      ...indicators,
      ema: [...indicators.ema],
      rsi: { ...indicators.rsi },
      macd: { ...indicators.macd },
      stochastic: { ...indicators.stochastic },
      bollinger: { ...indicators.bollinger },
      atr: { ...indicators.atr },
    };
    switch (id) {
      case 'EMA9':
        next.ema = toggleValue(next.ema, 9);
        break;
      case 'EMA20':
        next.ema = toggleValue(next.ema, 20);
        break;
      case 'EMA50':
        next.ema = toggleValue(next.ema, 50);
        break;
      case 'EMA100':
        next.ema = toggleValue(next.ema, 100);
        break;
      case 'EMA200':
        next.ema = toggleValue(next.ema, 200);
        break;
      case 'BB':
        next.bollinger.enabled = !next.bollinger.enabled;
        break;
      case 'RSI':
        next.rsi.enabled = !next.rsi.enabled;
        break;
      case 'MACD':
        next.macd.enabled = !next.macd.enabled;
        break;
      case 'STOCH':
        next.stochastic.enabled = !next.stochastic.enabled;
        break;
      case 'ATR':
        next.atr.enabled = !next.atr.enabled;
        break;
      default:
        break;
    }
    onIndicatorsChange(next);
  };

  const activeIndicators = new Set<string>([
    ...indicators.ema.map((period) => `EMA${period}`),
    ...(indicators.bollinger.enabled ? ['BB'] : []),
    ...(indicators.rsi.enabled ? ['RSI'] : []),
    ...(indicators.macd.enabled ? ['MACD'] : []),
    ...(indicators.stochastic.enabled ? ['STOCH'] : []),
    ...(indicators.atr.enabled ? ['ATR'] : []),
  ]);

  return (
    <div className="panel flex min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-panel-border px-2 py-1.5">
        <div className="flex items-center gap-0.5 rounded border border-panel-border bg-background/50 p-0.5">
          {TIMEFRAMES.map((candidate) => (
            <button
              key={candidate}
              type="button"
              onClick={() => onTimeframeChange(candidate)}
              className={cn(
                'rounded px-1.5 py-0.5 text-2xs font-semibold',
                timeframe === candidate ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {candidate}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-0.5 rounded border border-panel-border bg-background/50 p-0.5">
          {CHART_TYPES.map((type) => (
            <button
              key={type.id}
              type="button"
              onClick={() => onChartTypeChange(type.id)}
              className={cn(
                'rounded px-1.5 py-0.5 text-2xs font-semibold',
                chartType === type.id ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {type.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-0.5">
          {INDICATOR_CATALOG.map((indicator) => (
            <button
              key={indicator.id}
              type="button"
              title={indicator.description}
              onClick={() => toggleIndicator(indicator.id)}
              className={cn(
                'rounded border px-1.5 py-0.5 text-2xs font-medium transition-colors',
                activeIndicators.has(indicator.id)
                  ? 'border-primary/40 bg-primary/15 text-primary'
                  : 'border-panel-border text-muted-foreground hover:text-foreground',
              )}
            >
              {indicator.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => onToggleVolume?.(!showVolume)}
            className={cn(
              'rounded border px-1.5 py-0.5 text-2xs font-medium transition-colors',
              showVolume ? 'border-primary/40 bg-primary/15 text-primary' : 'border-panel-border text-muted-foreground hover:text-foreground',
            )}
          >
            Volume
          </button>
        </div>

        <span className="ml-auto flex items-center gap-2 text-2xs text-muted-foreground">
          {dataSource === 'DEMO_SIMULATED' ? (
            <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 font-semibold uppercase text-amber-300">Simulated data</span>
          ) : dataSource === 'MT5' ? (
            <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-semibold uppercase text-emerald-300">MT5 live</span>
          ) : null}
          {symbol}
        </span>
      </div>

      <div className="relative min-h-0 flex-1">
        {loading ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-panel/60">
            <Skeleton className="h-40 w-[80%]" />
          </div>
        ) : null}
        <div ref={containerRef} style={{ height }} className="w-full" />
      </div>

      {paneIndicators.length ? (
        <div className="grid gap-1 border-t border-panel-border p-1 md:grid-cols-2">
          {paneIndicators.map((pane) => (
            <OscillatorPane
              key={pane.id}
              label={pane.label}
              lines={pane.lines}
              histogram={pane.histogram}
              referenceLines={pane.referenceLines}
              range={pane.range}
              mainChart={chartRef.current}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function toggleValue(list: number[], value: number): number[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value].sort((a, b) => a - b);
}

interface OscillatorPaneProps {
  label: string;
  lines: { id: string; label: string; color: string; points: { time: number; value: number }[] }[];
  histogram?: { id: string; label: string; color: string; points: { time: number; value: number }[] }[];
  referenceLines?: number[];
  range?: { min: number; max: number };
  mainChart: IChartApi | null;
}

function OscillatorPane({ label, lines, histogram, referenceLines, range, mainChart }: OscillatorPaneProps): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const syncingRef = useRef(false);

  useEffect(() => {
    if (!ref.current) return undefined;
    const chart = createChart(ref.current, {
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: TEXT_COLOR, fontSize: 10 },
      grid: { vertLines: { color: GRID_COLOR }, horzLines: { color: GRID_COLOR } },
      rightPriceScale: { borderColor: GRID_COLOR, scaleMargins: { top: 0.15, bottom: 0.15 } },
      timeScale: { borderColor: GRID_COLOR, timeVisible: true, secondsVisible: false, visible: false },
      crosshair: { mode: CrosshairMode.Normal },
      handleScroll: { mouseWheel: false, pressedMouseMove: false },
      handleScale: { axisPressedMouseMove: false, mouseWheel: false, pinch: false },
      autoSize: true,
    });
    chartRef.current = chart;

    for (const line of lines) {
      if (!line.points.length) continue;
      const series = chart.addLineSeries({ color: line.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: true });
      series.setData(line.points.map((point) => ({ time: point.time as UTCTimestamp, value: point.value })));
    }
    for (const bar of histogram ?? []) {
      if (!bar.points.length) continue;
      const series = chart.addHistogramSeries({ color: bar.color, priceLineVisible: false, lastValueVisible: false });
      series.setData(
        bar.points.map((point) => ({
          time: point.time as UTCTimestamp,
          value: point.value,
          color: point.value >= 0 ? 'rgba(34,197,94,0.5)' : 'rgba(239,68,68,0.5)',
        })),
      );
    }
    for (const line of referenceLines ?? []) {
      // Draw the level as a flat line spanning the visible series range.
      const points = lines[0]?.points ?? histogram?.[0]?.points ?? [];
      if (points.length < 2) continue;
      const levelSeries = chart.addLineSeries({
        color: 'rgba(148,163,184,0.35)',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      levelSeries.setData([
        { time: points[0].time as UTCTimestamp, value: line },
        { time: points[points.length - 1].time as UTCTimestamp, value: line },
      ]);
    }
    if (range) {
      chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.15, bottom: 0.15 } });
    }

    // Keep the oscillator aligned with the main chart's time axis.
    const syncFromMain = (logicalRange: LogicalRange | null): void => {
      if (!logicalRange || syncingRef.current) return;
      syncingRef.current = true;
      chart.timeScale().setVisibleLogicalRange(logicalRange);
      syncingRef.current = false;
    };
    mainChart?.timeScale().subscribeVisibleLogicalRangeChange(syncFromMain);
    const initial = mainChart?.timeScale().getVisibleLogicalRange();
    if (initial) chart.timeScale().setVisibleLogicalRange(initial);

    return () => {
      mainChart?.timeScale().unsubscribeVisibleLogicalRangeChange(syncFromMain);
      chart.remove();
      chartRef.current = null;
    };
  }, [lines, histogram, referenceLines, range, mainChart]);

  return (
    <div className="rounded border border-panel-border/70 bg-background/30">
      <div className="flex items-center justify-between px-2 py-0.5 text-2xs uppercase tracking-wide text-muted-foreground">
        <span>{label}</span>
        <span className="flex items-center gap-2">
          {lines.map((line) => (
            <span key={line.id} className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: line.color }} />
              {line.label}
            </span>
          ))}
        </span>
      </div>
      <div ref={ref} style={{ height: 110 }} />
    </div>
  );
}

export { EMA_COLORS };
