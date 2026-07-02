import { useEffect, useRef, useState } from 'react';
import type { AssetRow } from '../../lib/plan/types';
import { getEffectiveValue } from '../../lib/plan/overrideManager';

type AssetPieChartProps = {
  assets: AssetRow[];
  height?: number;
};

export function AssetPieChart({ assets, height = 240 }: AssetPieChartProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const segmentsRef = useRef<
    Array<{ startAngle: number; endAngle: number; label: string; value: number; percent: number; color: string }>
  >([]);
  const geometryRef = useRef<{ centerX: number; centerY: number; radius: number; dpr: number }>({
    centerX: 0,
    centerY: 0,
    radius: 0,
    dpr: 1
  });
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    label: string;
    value: number;
    percent: number;
    color: string;
  } | null>(null);
  const [legendItems, setLegendItems] = useState<
    Array<{ label: string; value: number; percent: number; color: string }>
  >([]);

  const formatCurrency = (value: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, height);

    const groups = new Map<string, number>();
    assets.forEach((asset) => {
      const group = asset.group || asset.name || 'Other';
      const value = getEffectiveValue(asset);
      groups.set(group, (groups.get(group) || 0) + value);
    });
    const total = Array.from(groups.values()).reduce((sum, v) => sum + v, 0);
    if (total <= 0) {
      ctx.fillStyle = '#94a3b8';
      ctx.fillText('No asset data', 16, 24);
      setLegendItems([]);
      return;
    }

    const palette = ['#22c55e', '#0f766e', '#65a30d', '#a16207', '#dc2626', '#64748b'];
    let start = 0;
    const centerX = rect.width / 2;
    const centerY = height / 2;
    const radius = Math.min(rect.width, height) / 3;
    const nextSegments: Array<{
      startAngle: number;
      endAngle: number;
      label: string;
      value: number;
      percent: number;
      color: string;
    }> = [];
    let idx = 0;
    groups.forEach((value, label) => {
      const slice = (value / total) * Math.PI * 2;
      const color = palette[idx % palette.length];
      const percent = Number(((value / total) * 100).toFixed(1));
      ctx.beginPath();
      ctx.moveTo(centerX, centerY);
      ctx.arc(centerX, centerY, radius, start, start + slice);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      nextSegments.push({
        startAngle: start,
        endAngle: start + slice,
        label,
        value,
        percent,
        color
      });
      start += slice;
      idx += 1;
    });
    segmentsRef.current = nextSegments;
    geometryRef.current = { centerX: centerX * dpr, centerY: centerY * dpr, radius: radius * dpr, dpr };
    setLegendItems(
      nextSegments.map((s) => ({ label: s.label, value: s.value, percent: s.percent, color: s.color }))
    );
  }, [assets, height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleMove = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const { centerX, centerY, radius, dpr } = geometryRef.current;
      const x = (event.clientX - rect.left) * dpr;
      const y = (event.clientY - rect.top) * dpr;
      const dx = x - centerX;
      const dy = y - centerY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > radius || radius <= 0) {
        setTooltip(null);
        return;
      }
      let angle = Math.atan2(dy, dx);
      if (angle < 0) angle += Math.PI * 2;
      const segment = segmentsRef.current.find((s) => {
        if (s.endAngle < s.startAngle) {
          return angle >= s.startAngle || angle <= s.endAngle;
        }
        return angle >= s.startAngle && angle < s.endAngle;
      });
      if (!segment) {
        setTooltip(null);
        return;
      }
      setTooltip({
        x: event.clientX - rect.left + 12,
        y: event.clientY - rect.top - 12,
        label: segment.label,
        value: segment.value,
        percent: segment.percent,
        color: segment.color
      });
    };
    const handleLeave = () => setTooltip(null);
    canvas.addEventListener('mousemove', handleMove);
    canvas.addEventListener('mouseleave', handleLeave);
    return () => {
      canvas.removeEventListener('mousemove', handleMove);
      canvas.removeEventListener('mouseleave', handleLeave);
    };
  }, []);

  return (
    <div className="relative space-y-3">
      <canvas ref={canvasRef} className="w-full rounded-lg border border-slate-800 bg-slate-950" />
      {legendItems.length > 0 ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {legendItems.map((item) => (
            <div key={item.label} className="flex items-center gap-2">
              <span
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ backgroundColor: item.color }}
              />
              <span className="text-slate-300">{item.label}</span>
              <span className="text-slate-400">
                {formatCurrency(item.value)} ({item.percent}%)
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {tooltip ? (
        <div className="tmm-chart-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
          <div className="tmm-chart-tooltip__title" style={{ color: tooltip.color }}>
            {tooltip.label}
          </div>
          <div className="tmm-chart-tooltip__meta">{tooltip.percent}%</div>
          <div className="tmm-chart-tooltip__meta">{formatCurrency(tooltip.value)}</div>
        </div>
      ) : null}
    </div>
  );
}
