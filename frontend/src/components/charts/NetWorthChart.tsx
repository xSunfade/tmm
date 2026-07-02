import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SimulationSeries } from '../../lib/simulation/ledger';
import type { Augment } from '../../lib/plan/types';

type PercentileSeries = {
  alt: string;
  points: Array<{ date: Date; p10: number; p50: number; p90: number }>;
};

type NetWorthChartProps = {
  series: SimulationSeries[];
  percentileSeries?: PercentileSeries[];
  historicalSeries?: SimulationSeries[];
  height?: number;
  augments?: Augment[];
  altChartEnabled?: Record<string, boolean>;
  altColors?: Record<string, string>;
  granularity?: 'monthly' | 'daily';
};

type ViewWindow = { start: number; end: number };

const Y_AXIS_UPDATE_THRESHOLD = 0.05;
const palette = ['#8b5cf6', '#22c55e', '#06b6d4', '#f59e0b', '#ef4444'];
const AUGMENT_COLORS: Record<string, string> = {
  income: 'rgba(106, 227, 255, 0.6)',
  expense: 'rgba(255, 107, 107, 0.6)',
  asset: 'rgba(71, 209, 140, 0.6)',
  debt: 'rgba(244, 114, 182, 0.6)',
  global: 'rgba(106, 227, 255, 0.5)'
};

function formatCurrency(value: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
}

function formatAxisDate(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const y = date.getFullYear();
  return `${m}/${d}/${y}`;
}

const SLIDER_AXIS_TICKS = 6;

function getSliderAxisTicks(minX: number, maxX: number): Array<{ time: number; label: string }> {
  const range = maxX - minX;
  if (range <= 0) return [];
  const ticks: Array<{ time: number; label: string }> = [];
  for (let i = 0; i < SLIDER_AXIS_TICKS; i++) {
    const t = i / (SLIDER_AXIS_TICKS - 1);
    const time = minX + t * range;
    ticks.push({ time, label: formatAxisDate(new Date(time)) });
  }
  return ticks;
}

function addMonths(date: Date, months: number) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return next;
}

function getValueAtTime(points: { date: Date; value: number }[], time: number) {
  if (!points.length) return null;
  const first = points[0].date.getTime();
  const last = points[points.length - 1].date.getTime();
  if (time <= first) return points[0].value;
  if (time >= last) return points[points.length - 1].value;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi - 1) {
    const mid = Math.floor((lo + hi) / 2);
    const midTime = points[mid].date.getTime();
    if (midTime === time) return points[mid].value;
    if (midTime < time) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const range = b.date.getTime() - a.date.getTime();
  if (range <= 0) return a.value;
  const ratio = (time - a.date.getTime()) / range;
  return a.value + (b.value - a.value) * ratio;
}

function getPointMetaAtTime(
  points: Array<{ date: Date; value: number; source?: string; confidence?: string; reconciled?: boolean; needsReview?: boolean }>,
  time: number
) {
  const value = getValueAtTime(points, time);
  if (value === null) return null;
  if (!points.length) return { value, source: undefined, needsReview: false };
  if (time <= points[0].date.getTime()) {
    const point = points[0];
    return { value, source: point.source, confidence: point.confidence, reconciled: point.reconciled, needsReview: point.needsReview };
  }
  if (time >= points[points.length - 1].date.getTime()) {
    const point = points[points.length - 1];
    return { value, source: point.source, confidence: point.confidence, reconciled: point.reconciled, needsReview: point.needsReview };
  }
  let nearest = points[0];
  let nearestDistance = Math.abs(points[0].date.getTime() - time);
  points.forEach((p) => {
    const distance = Math.abs(p.date.getTime() - time);
    if (distance < nearestDistance) {
      nearest = p;
      nearestDistance = distance;
    }
  });
  return {
    value,
    source: nearest.source,
    confidence: nearest.confidence,
    reconciled: nearest.reconciled,
    needsReview: nearest.needsReview
  };
}

function formatPointSource(source?: string) {
  if (!source) return '';
  if (source === 'plaid_live') return 'Plaid live';
  if (source === 'plaid_archived') return 'Plaid archived';
  if (source === 'checkpoint_user') return 'Checkpoint';
  if (source === 'checkpoint_auto') return 'Auto checkpoint';
  if (source === 'manual') return 'Manual';
  return source;
}

function getAugmentColor(category: string) {
  return AUGMENT_COLORS[category] || AUGMENT_COLORS.global;
}

function withAlpha(color: string, alpha: number) {
  const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return color;
  return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${alpha})`;
}

function AugmentIcon({ category }: { category: string }) {
  switch (category) {
    case 'income':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M8 7V6a4 4 0 0 1 8 0v1h3a2 2 0 0 1 2 2v7a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V9a2 2 0 0 1 2-2h3zm2 0h4V6a2 2 0 1 0-4 0v1zm-5 4v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5H5z"
          />
        </svg>
      );
    case 'expense':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M7 3h10l4 4v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm9 2H7v16h12V8h-3a1 1 0 0 1-1-1V5zm-6 6h8v2h-8v-2zm0 4h8v2h-8v-2z"
          />
        </svg>
      );
    case 'asset':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M4 19h16v2H2V3h2v16zm5-6 3 3 6-6 2 2-8 8-5-5 2-2z"
          />
        </svg>
      );
    case 'debt':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M3 7a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7zm3-1a1 1 0 0 0-1 1v2h16V7a1 1 0 0 0-1-1H6zm-1 6v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5H5z"
          />
        </svg>
      );
    default:
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 2a10 10 0 1 1-7.07 2.93A9.93 9.93 0 0 1 12 2zm6.93 8H15.9a15.64 15.64 0 0 0-1.13-5.3A8.02 8.02 0 0 1 18.93 10zM9.23 4.7A15.64 15.64 0 0 0 8.1 10H5.07A8.02 8.02 0 0 1 9.23 4.7zM5.07 14H8.1a15.64 15.64 0 0 0 1.13 5.3A8.02 8.02 0 0 1 5.07 14zm4.83 0h4.2a13.74 13.74 0 0 1-1.1 4.87a7.98 7.98 0 0 1-2 0A13.74 13.74 0 0 1 9.9 14zm4.2-4h-4.2a13.74 13.74 0 0 1 1.1-4.87a7.98 7.98 0 0 1 2 0A13.74 13.74 0 0 1 14.1 10zm1.8 9.3A15.64 15.64 0 0 0 15.9 14h3.03a8.02 8.02 0 0 1-4.13 5.3z"
          />
        </svg>
      );
  }
}

function computeBounds(series: SimulationSeries[]) {
  let minX = Infinity;
  let maxX = -Infinity;
  series.forEach((s) => {
    s.points.forEach((p) => {
      const x = p.date.getTime();
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    });
  });
  if (!isFinite(minX) || !isFinite(maxX)) {
    const now = Date.now();
    return { minX: now, maxX: now };
  }
  return { minX, maxX };
}

/** Clamp view window to bounds so the curve always stays in view; preserves range when possible. */
function clampView(
  bounds: { minX: number; maxX: number },
  start: number,
  end: number,
  minRangePct: number = 0.01
): ViewWindow {
  const total = bounds.maxX - bounds.minX;
  if (total <= 0) return { start: bounds.minX, end: bounds.maxX };
  const minRange = total * minRangePct;
  let s = Math.min(start, end);
  let e = Math.max(start, end);
  let L = Math.max(e - s, minRange);
  if (s < bounds.minX) {
    s = bounds.minX;
    e = Math.min(bounds.maxX, s + L);
  }
  if (e > bounds.maxX) {
    e = bounds.maxX;
    s = Math.max(bounds.minX, e - L);
  }
  return { start: s, end: e };
}

export function NetWorthChart({
  series,
  percentileSeries = [],
  historicalSeries = [],
  height = 320,
  augments = [],
  altChartEnabled = {},
  altColors = {},
  granularity = 'monthly'
}: NetWorthChartProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sliderRef = useRef<HTMLDivElement | null>(null);
  const sliderCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const sliderCanvasColoredRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<ViewWindow | null>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [hoverDate, setHoverDate] = useState<Date | null>(null);
  const [chartSize, setChartSize] = useState<{ width: number; height: number }>({ width: 0, height });
  const [sliderSize, setSliderSize] = useState<{ width: number; height: number }>({ width: 0, height: 60 });
  const [hoveredAugment, setHoveredAugment] = useState<Augment | null>(null);
  const [augmentTooltipStyle, setAugmentTooltipStyle] = useState<{ left: number; top: number } | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const previousY = useRef<{ min: number; max: number } | null>(null);
  const previousYView = useRef<{ start: number; end: number } | null>(null);
  const rafId = useRef<number | null>(null);
  const dragRaf = useRef<number | null>(null);
  const pendingView = useRef<ViewWindow | null>(null);
  const lastViewUpdateAt = useRef<number>(0);
  const MIN_VIEW_UPDATE_INTERVAL_MS = 16;

  const clippedSeries = useMemo(() => {
    const todayCutoff = new Date();
    todayCutoff.setHours(0, 0, 0, 0);
    const todayMs = todayCutoff.getTime();

    const lastHistoricalValueByAlt = new Map<string, number>();
    historicalSeries.forEach((hs) => {
      if (hs.points.length > 0) {
        const sorted = [...hs.points].sort((a, b) => a.date.getTime() - b.date.getTime());
        lastHistoricalValueByAlt.set(hs.alt, sorted[sorted.length - 1].value);
      }
    });

    return series.map((s) => {
      const futurePoints = s.points.filter((p) => p.date.getTime() >= todayMs);
      if (futurePoints.length === 0) return { ...s, points: [] };

      const lastHistVal = lastHistoricalValueByAlt.get(s.alt);
      if (lastHistVal !== undefined && futurePoints[0].date.getTime() > todayMs) {
        return {
          ...s,
          points: [{ date: todayCutoff, value: lastHistVal }, ...futurePoints]
        };
      }
      return { ...s, points: futurePoints };
    });
  }, [series, historicalSeries]);

  const clippedPercentileSeries = useMemo(() => {
    const todayCutoff = new Date();
    todayCutoff.setHours(0, 0, 0, 0);
    const todayMs = todayCutoff.getTime();
    return percentileSeries.map((band) => ({
      ...band,
      points: band.points.filter((p) => p.date.getTime() >= todayMs)
    }));
  }, [percentileSeries]);

  const allSeries = useMemo(() => [...clippedSeries, ...historicalSeries], [clippedSeries, historicalSeries]);
  const bounds = useMemo(() => computeBounds(allSeries), [allSeries]);

  // Always show full timeline when we have valid bounds (e.g. on dashboard load or when data changes)
  useEffect(() => {
    if (bounds.minX < bounds.maxX) {
      setView({ start: bounds.minX, end: bounds.maxX });
    }
  }, [bounds.minX, bounds.maxX]);

  useEffect(() => {
    if (!containerRef.current) return;
    const element = containerRef.current;
    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      setChartSize({ width: rect.width, height });
    };
    updateSize();
    const observer = new ResizeObserver(() => updateSize());
    observer.observe(element);
    return () => observer.disconnect();
  }, [height]);

  useEffect(() => {
    if (!sliderRef.current) return;
    const element = sliderRef.current;
    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      setSliderSize({ width: rect.width, height: rect.height });
    };
    updateSize();
    const observer = new ResizeObserver(() => updateSize());
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!canvasRef.current || !view) return;
    if (rafId.current) {
      cancelAnimationFrame(rafId.current);
    }
    rafId.current = requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 1) {
        return;
      }
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = height * dpr;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, height);

      const pad = 36;
      let effectiveView = clampView(bounds, view.start, view.end);
      let viewRange = effectiveView.end - effectiveView.start || 1;
      let xToPx = (time: number) => pad + ((time - effectiveView.start) / viewRange) * (rect.width - pad * 2);
      let pointsInView: number[] = [];
      const collectPoints = (v: ViewWindow) => {
        const out: number[] = [];
        allSeries.forEach((s) => {
          s.points.forEach((p, idx) => {
            const time = p.date.getTime();
            if (time < v.start || time > v.end) return;
            out.push(p.value);
            if (idx > 0) {
              const prevTime = s.points[idx - 1].date.getTime();
              if (prevTime < v.start && time >= v.start) out.push(s.points[idx - 1].value);
            }
            if (idx < s.points.length - 1) {
              const nextTime = s.points[idx + 1].date.getTime();
              if (nextTime > v.end && time <= v.end) out.push(s.points[idx + 1].value);
            }
          });
        });
        return out;
      };
      pointsInView = collectPoints(effectiveView);
      const hasData = allSeries.some((s) => s.points.length > 0);
      if (pointsInView.length === 0 && hasData && bounds.minX < bounds.maxX) {
        effectiveView = { start: bounds.minX, end: bounds.maxX };
        viewRange = effectiveView.end - effectiveView.start || 1;
        xToPx = (time: number) => pad + ((time - effectiveView.start) / viewRange) * (rect.width - pad * 2);
        pointsInView = collectPoints(effectiveView);
      }

    let minY = Math.min(...pointsInView);
    let maxY = Math.max(...pointsInView);
    if (!isFinite(minY) || !isFinite(maxY)) {
      minY = 0;
      maxY = 1;
    }
    if (minY === maxY) {
      minY -= 1;
      maxY += 1;
    }
    const range = maxY - minY;
    minY -= range * 0.075;
    maxY += range * 0.075;

    const totalX = bounds.maxX - bounds.minX;
    const viewCenter = (effectiveView.start + effectiveView.end) / 2;
    const viewPannedFar =
      totalX > 0 &&
      previousYView.current &&
      Math.abs(viewCenter - (previousYView.current.start + previousYView.current.end) / 2) / totalX > 0.25;
    if (viewPannedFar) {
      previousY.current = { min: minY, max: maxY };
      previousYView.current = { start: effectiveView.start, end: effectiveView.end };
    } else if (previousY.current) {
      const prevRange = previousY.current.max - previousY.current.min;
      const newRange = maxY - minY;
      const prevCenter = (previousY.current.min + previousY.current.max) / 2;
      const newCenter = (minY + maxY) / 2;
      const centerShiftRatio = prevRange > 0 ? Math.abs(newCenter - prevCenter) / prevRange : 1;
      const noOverlap = maxY < previousY.current.min || minY > previousY.current.max;
      if (prevRange > 0) {
        const change = Math.abs(newRange - prevRange) / prevRange;
        if (change < Y_AXIS_UPDATE_THRESHOLD && centerShiftRatio < 0.15 && !noOverlap) {
          minY = previousY.current.min;
          maxY = previousY.current.max;
        } else {
          previousY.current = { min: minY, max: maxY };
          previousYView.current = { start: effectiveView.start, end: effectiveView.end };
        }
      } else {
        previousY.current = { min: minY, max: maxY };
        previousYView.current = { start: effectiveView.start, end: effectiveView.end };
      }
    } else {
      previousY.current = { min: minY, max: maxY };
      previousYView.current = { start: effectiveView.start, end: effectiveView.end };
    }

      const yToPx = (value: number) =>
        height - pad - ((value - minY) / (maxY - minY)) * (height - pad * 2);

    ctx.strokeStyle = '#1a2636';
    ctx.lineWidth = 1;
    for (let i = 0; i < 6; i++) {
      const y = pad + (i * (height - pad * 2)) / 5;
      ctx.beginPath();
      ctx.moveTo(pad, y);
      ctx.lineTo(rect.width - pad, y);
      ctx.stroke();
    }

    ctx.fillStyle = '#9fb0c3';
    ctx.font = '12px system-ui';
    for (let i = 0; i < 5; i++) {
      const t = i / 4;
      const val = minY + t * (maxY - minY);
      ctx.fillText(formatCurrency(val), 4, yToPx(val) - 4);
    }

    // X-axis: line and date labels (MM/DD/YYYY)
    const xAxisY = height - pad;
    ctx.strokeStyle = '#1a2636';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, xAxisY);
    ctx.lineTo(rect.width - pad, xAxisY);
    ctx.stroke();

    const numXTicks = Math.min(7, Math.max(5, Math.floor((rect.width - pad * 2) / 80)));
    ctx.fillStyle = '#9fb0c3';
    ctx.font = '11px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i < numXTicks; i++) {
      const t = numXTicks === 1 ? 0.5 : i / (numXTicks - 1);
      const time = effectiveView.start + t * (effectiveView.end - effectiveView.start);
      const date = new Date(time);
      const x = xToPx(time);
      if (x >= pad && x <= rect.width - pad) {
        ctx.fillText(formatAxisDate(date), x, xAxisY + 6);
      }
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    const enabledAugments = augments.filter((augment) => augment.enabled && augment.activation?.startDate);
      enabledAugments.forEach((augment) => {
        const startDate = new Date(augment.activation.startDate);
        const startX = xToPx(startDate.getTime());
        if (startX < pad || startX > rect.width - pad) return;
        const color = getAugmentColor(augment.category);
        if (augment.duration?.type === 'temporary' && augment.duration.months && augment.duration.months > 0) {
          const endDate = addMonths(startDate, augment.duration.months);
          const endX = xToPx(endDate.getTime());
          const shadeStart = Math.max(pad, startX);
          const shadeEnd = Math.min(rect.width - pad, endX);
          if (shadeEnd > shadeStart) {
            ctx.fillStyle = withAlpha(color, 0.08);
            ctx.fillRect(shadeStart, pad, shadeEnd - shadeStart, height - pad * 2);
          }
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(startX, pad);
        ctx.lineTo(startX, height - pad);
        ctx.stroke();
        ctx.setLineDash([]);
      });

      clippedPercentileSeries.forEach((band, idx) => {
        if (altChartEnabled[band.alt] === false) return;
        const color = altColors[band.alt] || palette[idx % palette.length];
        const visible = band.points.filter((p) => {
          const time = p.date.getTime();
          return time >= effectiveView.start && time <= effectiveView.end;
        });
        if (!visible.length) return;
        ctx.beginPath();
        let started = false;
        visible.forEach((point) => {
          const x = xToPx(point.date.getTime());
          const y = yToPx(point.p10);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        });
        for (let i = visible.length - 1; i >= 0; i -= 1) {
          const point = visible[i];
          const x = xToPx(point.date.getTime());
          const y = yToPx(point.p90);
          ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fillStyle = withAlpha(color, 0.12);
        ctx.fill();
      });

      allSeries.forEach((s, idx) => {
        if (altChartEnabled[s.alt] === false) return;
        const color = altColors[s.alt] || palette[idx % palette.length];
        ctx.strokeStyle = color;
        ctx.lineWidth = s.isHistorical ? 1.5 : 2;
        ctx.setLineDash(s.isHistorical ? [6, 4] : []);
        ctx.beginPath();
        let started = false;
        s.points.forEach((p) => {
          const time = p.date.getTime();
          if (time < effectiveView.start || time > effectiveView.end) return;
          const x = xToPx(time);
          const y = yToPx(p.value);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        });
        ctx.stroke();
        ctx.setLineDash([]);
      });

      if (hoverDate && hoverX !== null && hoverX >= pad && hoverX <= rect.width - pad) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const isBeforeToday = hoverDate.getTime() < today.getTime();
        const headerText = isBeforeToday ? 'HISTORY' : 'FUTURE PROJECTION';
        const headerColor = isBeforeToday ? 'rgba(49,195,255,0.9)' : 'rgba(106,227,255,0.9)';
        const dateLabel =
          granularity === 'daily'
            ? hoverDate.toLocaleDateString()
            : hoverDate.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });

        ctx.strokeStyle = '#2a415c';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(hoverX, pad);
        ctx.lineTo(hoverX, height - pad);
        ctx.stroke();
        ctx.setLineDash([]);

        const tooltipLines: Array<{ text: string; color: string; y: number }> = [];
        const sourceSeries = isBeforeToday && historicalSeries.length ? historicalSeries : clippedSeries;
        sourceSeries.forEach((s, idx) => {
          if (altChartEnabled[s.alt] === false) return;
          const pointMeta = getPointMetaAtTime(s.points, hoverDate.getTime());
          if (!pointMeta || pointMeta.value === null || !isFinite(pointMeta.value)) return;
          const color = altColors[s.alt] || palette[idx % palette.length];
          const y = yToPx(pointMeta.value);
          const sourceLabel = formatPointSource(pointMeta.source);
          const reviewSuffix = pointMeta.needsReview ? ' (needs review)' : '';
          const sourceSuffix = sourceLabel ? ` - ${sourceLabel}${reviewSuffix}` : '';
          tooltipLines.push({ text: `${s.alt}: ${formatCurrency(pointMeta.value)}${sourceSuffix}`, color, y });
        });

        tooltipLines.forEach((line) => {
          ctx.fillStyle = line.color;
          ctx.beginPath();
          ctx.arc(hoverX, line.y, 4, 0, Math.PI * 2);
          ctx.fill();
        });

        ctx.font = '10px system-ui';
        let tooltipWidth = Math.max(ctx.measureText(headerText).width, ctx.measureText(dateLabel).width);
        ctx.font = '12px system-ui';
        tooltipLines.forEach((line) => {
          tooltipWidth = Math.max(tooltipWidth, ctx.measureText(line.text).width);
        });
        tooltipWidth += 16;

        const headerHeight = 20;
        const lineHeight = 16;
        const tooltipHeight = headerHeight + 16 + tooltipLines.length * lineHeight + 8;
        const baseY = tooltipLines[0]?.y ?? height / 2;
        let tooltipX = hoverX + 10;
        let tooltipY = baseY - tooltipHeight - 10;
        if (tooltipX + tooltipWidth > rect.width - pad) tooltipX = hoverX - tooltipWidth - 10;
        if (tooltipY < pad) tooltipY = baseY + 10;

        ctx.fillStyle = 'rgba(8, 12, 20, 0.85)';
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(tooltipX, tooltipY, tooltipWidth, tooltipHeight, 10);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = headerColor;
        ctx.font = '10px system-ui';
        ctx.fillText(headerText, tooltipX + 8, tooltipY + 14);
        ctx.fillStyle = '#cfe6ff';
        ctx.font = '12px system-ui';
        ctx.fillText(dateLabel, tooltipX + 8, tooltipY + headerHeight + 12);

        const valuesStartY = tooltipY + headerHeight + 28;
        tooltipLines.forEach((line, index) => {
          ctx.fillStyle = line.color;
          ctx.fillText(line.text, tooltipX + 8, valuesStartY + index * lineHeight);
        });
      }
    });
  }, [
    allSeries,
    height,
    view,
    augments,
    altChartEnabled,
    altColors,
    hoverDate,
    hoverX,
    historicalSeries,
    clippedSeries,
    clippedPercentileSeries,
    granularity
  ]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !view) return;
    let dragging = false;
    let dragStartX = 0;
    let dragStartView: ViewWindow | null = null;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const cursorRatio = (event.clientX - rect.left) / rect.width;
      const range = view.end - view.start;
      const zoom = event.deltaY > 0 ? 1.2 : 0.8;
      const totalRange = bounds.maxX - bounds.minX;
      const minRange = totalRange / 100;
      const newRange = Math.min(totalRange, Math.max(range * zoom, minRange));
      const center = view.start + range * cursorRatio;
      let nextStart = center - newRange * cursorRatio;
      let nextEnd = center + newRange * (1 - cursorRatio);
      if (nextStart < bounds.minX) {
        nextStart = bounds.minX;
        nextEnd = bounds.minX + newRange;
      }
      if (nextEnd > bounds.maxX) {
        nextEnd = bounds.maxX;
        nextStart = bounds.maxX - newRange;
      }
      const clamped = clampView(bounds, nextStart, nextEnd);
      setView(clamped);
    };

    const onMouseDown = (event: MouseEvent) => {
      dragging = true;
      dragStartX = event.clientX;
      dragStartView = { ...view };
      canvas.style.cursor = 'grabbing';
    };

    const onMouseMoveDrag = (event: MouseEvent) => {
      if (!dragging || !dragStartView) return;
      const rect = canvas.getBoundingClientRect();
      const dx = event.clientX - dragStartX;
      const range = dragStartView.end - dragStartView.start;
      const shift = (dx / rect.width) * range;
      const nextStart = dragStartView.start - shift;
      const nextEnd = dragStartView.end - shift;
      setView(clampView(bounds, nextStart, nextEnd));
    };

    const onMouseUp = () => {
      dragging = false;
      dragStartView = null;
      canvas.style.cursor = 'default';
    };

    const onMove = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const time = view.start + ((view.end - view.start) * x) / rect.width;
      setHoverX(x);
      setHoverDate(new Date(time));
    };

    const onLeave = () => {
      setHoverX(null);
      setHoverDate(null);
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);
    window.addEventListener('mousemove', onMouseMoveDrag);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseleave', onLeave);
      window.removeEventListener('mousemove', onMouseMoveDrag);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [bounds.maxX, bounds.minX, series, view]);

  const augmentMarkers = useMemo(() => {
    if (!view || chartSize.width === 0) return [];
    const pad = 36;
    const viewRange = view.end - view.start || 1;
    const enabled = augments.filter((augment) => augment.enabled && augment.activation?.startDate);
    const grouped = new Map<string, Augment[]>();
    enabled.forEach((augment) => {
      const key = augment.activation.startDate;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)?.push(augment);
    });
    const markers: Array<{ augment: Augment; x: number; y: number; color: string }> = [];
    grouped.forEach((items, dateKey) => {
      const startDate = new Date(dateKey);
      const baseX =
        pad + ((startDate.getTime() - view.start) / viewRange) * (chartSize.width - pad * 2);
      const step = 12;
      const offsetStart = -((items.length - 1) * step) / 2;
      items.forEach((augment, index) => {
        let x = baseX + offsetStart + index * step;
        x = Math.max(pad, Math.min(chartSize.width - pad, x));
        markers.push({
          augment,
          x,
          y: pad + 6,
          color: getAugmentColor(augment.category)
        });
      });
    });
    return markers.filter((marker) => marker.x >= 36 && marker.x <= chartSize.width - 36);
  }, [augments, chartSize.width, view]);

  const todayMarker = useMemo(() => {
    if (!view || chartSize.width === 0) return null;
    const pad = 36;
    const viewRange = view.end - view.start || 1;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const x = pad + ((today.getTime() - view.start) / viewRange) * (chartSize.width - pad * 2);
    if (x < pad || x > chartSize.width - pad) return null;
    return { x, top: pad };
  }, [view, chartSize.width]);

  useEffect(() => {
    if (!sliderRef.current || !sliderCanvasRef.current || !view) return;
    const slider = sliderRef.current;
    const canvas = sliderCanvasRef.current;
    const canvasColored = sliderCanvasColoredRef.current;
    const width = slider.offsetWidth;
    const height = slider.offsetHeight;
    const dpr = window.devicePixelRatio || 1;
    const trackLeft = 40;
    const trackWidth = width - trackLeft * 2;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    let ctxColored: CanvasRenderingContext2D | null = null;
    if (canvasColored) {
      canvasColored.width = width * dpr;
      canvasColored.height = height * dpr;
      canvasColored.style.width = `${width}px`;
      canvasColored.style.height = `${height}px`;
      ctxColored = canvasColored.getContext('2d');
      if (ctxColored) {
        ctxColored.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctxColored.clearRect(0, 0, width, height);
      }
    }

    const enabledSeries = allSeries.filter((s) => altChartEnabled[s.alt] !== false);
    if (!enabledSeries.length) return;

    let minY = Infinity;
    let maxY = -Infinity;
    enabledSeries.forEach((s) => {
      s.points.forEach((p) => {
        minY = Math.min(minY, p.value);
        maxY = Math.max(maxY, p.value);
      });
    });
    if (!isFinite(minY) || !isFinite(maxY)) return;
    if (minY === maxY) {
      minY -= 1;
      maxY += 1;
    }
    const yToPx = (value: number) =>
      height - 10 - ((value - minY) / (maxY - minY)) * (height - 20);
    const totalRange = bounds.maxX - bounds.minX || 1;
    const timeToX = (time: number) => trackLeft + ((time - bounds.minX) / totalRange) * trackWidth;

    enabledSeries.forEach((s, idx) => {
      const color = altColors[s.alt] || palette[idx % palette.length];
      ctx.strokeStyle = withAlpha(color, 0.35);
      ctx.lineWidth = s.isHistorical ? 1 : 1.5;
      ctx.setLineDash(s.isHistorical ? [4, 4] : []);
      ctx.beginPath();
      s.points.forEach((p, i) => {
        const x = timeToX(p.date.getTime());
        const y = yToPx(p.value);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);

      if (ctxColored) {
        ctxColored.save();
        const windowStart = view.start - bounds.minX;
        const windowEnd = view.end - bounds.minX;
        const windowLeft = trackLeft + (windowStart / totalRange) * trackWidth;
        const windowWidth = ((windowEnd - windowStart) / totalRange) * trackWidth;
        ctxColored.beginPath();
        ctxColored.rect(windowLeft, 0, windowWidth, height);
        ctxColored.clip();
        ctxColored.strokeStyle = color;
        ctxColored.lineWidth = s.isHistorical ? 1 : 1.5;
        ctxColored.setLineDash(s.isHistorical ? [4, 4] : []);
        ctxColored.beginPath();
        s.points.forEach((p, i) => {
          const x = timeToX(p.date.getTime());
          const y = yToPx(p.value);
          if (i === 0) ctxColored.moveTo(x, y);
          else ctxColored.lineTo(x, y);
        });
        ctxColored.stroke();
        ctxColored.setLineDash([]);
        ctxColored.restore();
      }
    });
  }, [allSeries, altChartEnabled, altColors, bounds.maxX, bounds.minX, palette, view]);

  useLayoutEffect(() => {
    if (!hoveredAugment || !tooltipRef.current || !augmentTooltipStyle) return;
    const tooltip = tooltipRef.current;
    const rect = tooltip.getBoundingClientRect();
    const margin = 10;
    const desiredLeft = augmentTooltipStyle.left;
    const desiredTop = augmentTooltipStyle.top;
    let left = Math.max(margin, Math.min(window.innerWidth - rect.width - margin, desiredLeft));
    let top = desiredTop;
    if (top - rect.height < margin) {
      top = desiredTop + rect.height + 16;
    }
    if (left !== augmentTooltipStyle.left || top !== augmentTooltipStyle.top) {
      setAugmentTooltipStyle({ left, top });
    }
  }, [augmentTooltipStyle, hoveredAugment]);

  const sliderRange = bounds.maxX - bounds.minX || 1;
  const sliderPadding = 40;
  const trackWidth = Math.max(0, sliderSize.width - sliderPadding * 2);
  const windowStartPx = view ? sliderPadding + ((view.start - bounds.minX) / sliderRange) * trackWidth : sliderPadding;
  const windowWidthPx = view ? ((view.end - view.start) / sliderRange) * trackWidth : trackWidth;

  const updateViewWindow = (nextStart: number, nextEnd: number) => {
    const clamped = clampView(bounds, nextStart, nextEnd);
    lastViewUpdateAt.current = Date.now();
    setView(clamped);
  };

  const scheduleViewUpdate = (nextStart: number, nextEnd: number) => {
    const clamped = clampView(bounds, nextStart, nextEnd);
    pendingView.current = clamped;
    if (dragRaf.current !== null) return;
    const run = () => {
      dragRaf.current = null;
      if (!pendingView.current) return;
      const now = Date.now();
      const elapsed = lastViewUpdateAt.current ? now - lastViewUpdateAt.current : MIN_VIEW_UPDATE_INTERVAL_MS;
      if (elapsed >= MIN_VIEW_UPDATE_INTERVAL_MS || !lastViewUpdateAt.current) {
        lastViewUpdateAt.current = now;
        setView(pendingView.current);
        pendingView.current = null;
      } else {
        dragRaf.current = window.requestAnimationFrame(run);
      }
    };
    dragRaf.current = window.requestAnimationFrame(run);
  };

  const startDragHandle = (type: 'left' | 'right' | 'window', event: React.MouseEvent) => {
    event.preventDefault();
    if (!sliderRef.current || !view) return;
    sliderRef.current.getBoundingClientRect();
    const startX = event.clientX;
    const startView = { ...view };
    const totalRange = bounds.maxX - bounds.minX || 1;
    const pixelsPerMs = trackWidth / totalRange;
    const onMove = (moveEvent: MouseEvent) => {
      const dx = moveEvent.clientX - startX;
      const delta = dx / pixelsPerMs;
      if (type === 'window') {
        scheduleViewUpdate(startView.start + delta, startView.end + delta);
      } else if (type === 'left') {
        const minRange = totalRange / 100;
        scheduleViewUpdate(Math.min(startView.end - minRange, startView.start + delta), startView.end);
      } else {
        const minRange = totalRange / 100;
        scheduleViewUpdate(startView.start, Math.max(startView.start + minRange, startView.end + delta));
      }
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (dragRaf.current !== null) {
        cancelAnimationFrame(dragRaf.current);
        dragRaf.current = null;
      }
      if (pendingView.current) {
        lastViewUpdateAt.current = Date.now();
        setView(pendingView.current);
        pendingView.current = null;
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const hoveredDetails = hoveredAugment
    ? (() => {
        const startDate = new Date(hoveredAugment.activation.startDate);
        const dateStr = startDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        const duration =
          hoveredAugment.duration?.type === 'instant'
            ? 'One-time'
            : hoveredAugment.duration?.type === 'permanent'
            ? 'Permanent'
            : hoveredAugment.duration?.months
            ? `${hoveredAugment.duration.months} months`
            : '';
        const probability =
          hoveredAugment.activation?.probability < 1
            ? `${Math.round(hoveredAugment.activation.probability * 100)}% chance`
            : '';
        return { dateStr, duration, probability, color: getAugmentColor(hoveredAugment.category) };
      })()
    : null;

  return (
    <div className="space-y-3">
      <div ref={containerRef} className="relative" style={{ height }}>
        <canvas ref={canvasRef} className="h-full w-full rounded-lg border border-slate-800 bg-slate-950" />
        <div className="pointer-events-none absolute inset-0 z-10">
          {augmentMarkers.map((marker) => (
            <div
              key={`${marker.augment.id}-${marker.x}`}
              className="pointer-events-auto absolute flex h-6 w-6 items-center justify-center rounded-full border border-slate-800 bg-slate-950/90 text-xs shadow-sm"
              style={{ left: marker.x - 12, top: marker.y - 12, color: marker.color }}
              onMouseEnter={(event) => {
                setHoveredAugment(marker.augment);
                const rect = (event.currentTarget as HTMLDivElement).getBoundingClientRect();
                setAugmentTooltipStyle({ left: rect.left + rect.width / 2, top: rect.top - 8 });
              }}
              onMouseLeave={() => {
                setHoveredAugment(null);
                setAugmentTooltipStyle(null);
              }}
            >
              <AugmentIcon category={marker.augment.category} />
            </div>
          ))}
        </div>
        {todayMarker ? (
          <div className="pointer-events-none absolute inset-0 z-30">
            <div
              className="absolute border-l-2 border-dashed border-yellow-400/70"
              style={{ left: todayMarker.x, top: todayMarker.top, height: height - todayMarker.top * 2 }}
              aria-hidden
            />
            <div
              className="absolute rounded bg-slate-950/80 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-yellow-400 shadow-sm"
              style={{ left: todayMarker.x - 4, top: todayMarker.top + 4, transform: 'translateX(-100%)' }}
            >
              Today
            </div>
          </div>
        ) : null}
      </div>
      {hoveredAugment && augmentTooltipStyle ? (
        <div
          ref={tooltipRef}
          className="fixed z-[10000] max-w-xs rounded-lg border border-slate-700 bg-slate-950/95 p-3 text-xs text-slate-200 shadow-lg backdrop-blur"
          style={{ left: augmentTooltipStyle.left, top: augmentTooltipStyle.top }}
        >
          <div className="text-sm font-semibold" style={{ color: hoveredDetails?.color }}>
            {hoveredAugment.name}
          </div>
          <div className="mt-1 text-[11px] text-slate-400">{hoveredAugment.description || 'No description'}</div>
          <div className="mt-2 text-[11px] text-slate-300">Date: {hoveredDetails?.dateStr}</div>
          {hoveredDetails?.duration ? (
            <div className="text-[11px] text-slate-300">Duration: {hoveredDetails.duration}</div>
          ) : null}
          {hoveredDetails?.probability ? (
            <div className="text-[11px] text-slate-300">{hoveredDetails.probability}</div>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-col gap-0">
        <div ref={sliderRef} className="timeline-slider" data-tour="timeline-slider">
          <canvas ref={sliderCanvasRef} className="timeline-slider-canvas" />
          <canvas ref={sliderCanvasColoredRef} className="timeline-slider-canvas-colored" />
          <div
            className="timeline-slider-track"
            onMouseDown={(event) => {
              if (!sliderRef.current || !view) return;
              const rect = sliderRef.current.getBoundingClientRect();
              const clickX = event.clientX - rect.left;
              const totalRange = bounds.maxX - bounds.minX || 1;
              const t = Math.min(1, Math.max(0, (clickX - sliderPadding) / trackWidth));
              const center = bounds.minX + t * totalRange;
              const range = view.end - view.start;
              updateViewWindow(center - range / 2, center + range / 2);
            }}
          />
          <div
            className="timeline-slider-window"
            style={{ left: `${windowStartPx}px`, width: `${windowWidthPx}px` }}
            onMouseDown={(event) => startDragHandle('window', event)}
          />
          <div
            className="timeline-slider-handle timeline-slider-handle-left"
            style={{ left: `${windowStartPx - 4}px` }}
            onMouseDown={(event) => startDragHandle('left', event)}
          />
          <div
            className="timeline-slider-handle timeline-slider-handle-right"
            style={{ left: `${windowStartPx + windowWidthPx - 4}px` }}
            onMouseDown={(event) => startDragHandle('right', event)}
          />
        </div>
        {bounds.minX < bounds.maxX && (
          <div className="timeline-slider-axis" style={{ position: 'relative', width: '100%', height: 28 }}>
            {getSliderAxisTicks(bounds.minX, bounds.maxX).map(({ time, label }) => (
              <span
                key={time}
                className="timeline-slider-axis-tick"
                style={{
                  position: 'absolute',
                  left: `${sliderPadding + ((time - bounds.minX) / sliderRange) * trackWidth}px`,
                  transform: 'translateX(-50%)',
                  top: 8
                }}
              >
                {label}
              </span>
            ))}
            {view && (
              <>
                <div
                  className="timeline-slider-view-dates timeline-slider-view-date-start"
                  style={{
                    left: `${windowStartPx}px`,
                    top: 0
                  }}
                  aria-live="polite"
                >
                  {formatAxisDate(new Date(view.start))}
                </div>
                <div
                  className="timeline-slider-view-dates timeline-slider-view-date-end"
                  style={{
                    left: `${windowStartPx + windowWidthPx}px`,
                    top: 0
                  }}
                  aria-live="polite"
                >
                  {formatAxisDate(new Date(view.end))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

