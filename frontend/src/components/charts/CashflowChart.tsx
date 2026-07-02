import { useEffect, useRef, useState } from 'react';
import type { Alternative } from '../../lib/plan/types';
import { FPM } from '../../lib/plan/frequency';
import { getEffectiveValue } from '../../lib/plan/overrideManager';

type CashflowChartProps = {
  alt: Alternative;
  height?: number;
};

export function CashflowChart({ alt, height = 220 }: CashflowChartProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const barRef = useRef<
    Array<{ x: number; y: number; width: number; height: number; label: string; value: number; color: string }>
  >([]);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; label: string; value: number; color: string } | null>(null);

  const formatCurrency = (value: number) => {
    const formatted = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0
    }).format(Math.abs(value));
    if (value === 0) return formatted;
    return value > 0 ? `+${formatted}` : `-${formatted}`;
  };

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

    const income = alt.income.reduce((sum, row) => sum + getEffectiveValue(row) * (FPM[row.freq] || 1), 0);
    const expense = alt.expense.reduce((sum, row) => sum + getEffectiveValue(row) * (FPM[row.freq] || 1), 0);
    const debt = alt.debt.reduce((sum, row) => sum + (row.pmt || 0) * (FPM[row.freq] || 1), 0);
    const asset = alt.asset.reduce((sum, row) => sum + (row.recurAmt || 0) * (FPM[row.recurFreq || 'monthly'] || 1), 0);

    const getColorFromCSSVar = (cssVar: string) => {
      const tempEl = document.createElement('div');
      tempEl.style.color = cssVar;
      document.body.appendChild(tempEl);
      const computedColor = window.getComputedStyle(tempEl).color;
      document.body.removeChild(tempEl);
      return computedColor;
    };
    const positiveColor = getColorFromCSSVar('var(--positive)');
    const negativeColor = getColorFromCSSVar('var(--red)');
    const values = [
      { label: 'Income', value: income, color: positiveColor },
      { label: 'Expenses', value: -expense, color: negativeColor },
      { label: 'Debt', value: -debt, color: negativeColor },
      { label: 'Assets', value: asset, color: positiveColor }
    ];

    const maxPos = Math.max(...values.map((v) => (v.value > 0 ? v.value : 0)), 1);
    const maxNeg = Math.max(...values.map((v) => (v.value < 0 ? -v.value : 0)), 1);
    const max = Math.max(maxPos, maxNeg, 1);
    const barWidth = rect.width / values.length - 20;
    const baselineY = height / 2;
    const chartHeight = height - 40;
    const halfChart = chartHeight / 2;
    const scale = halfChart / max;

    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, baselineY);
    ctx.lineTo(rect.width, baselineY);
    ctx.stroke();

    const nextBars: Array<{
      x: number;
      y: number;
      width: number;
      height: number;
      label: string;
      value: number;
      color: string;
    }> = [];
    values.forEach((item, idx) => {
      const x = idx * (barWidth + 20) + 20;
      const barHeight = Math.abs(item.value) * scale;
      const barHeightPx = Math.max(barHeight, 2);
      let y: number;
      const valueStr = formatCurrency(item.value);
      if (item.value >= 0) {
        y = baselineY - barHeightPx;
        ctx.fillStyle = item.color;
        ctx.fillRect(x, y, barWidth, barHeightPx);
        ctx.fillStyle = '#e2e8f0';
        ctx.font = '11px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText(valueStr, x + barWidth / 2, baselineY + 14);
      } else {
        y = baselineY;
        ctx.fillStyle = item.color;
        ctx.fillRect(x, y, barWidth, barHeightPx);
        ctx.fillStyle = '#e2e8f0';
        ctx.font = '11px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText(valueStr, x + barWidth / 2, baselineY - 4);
      }
      ctx.textAlign = 'left';
      ctx.fillStyle = '#e2e8f0';
      ctx.font = '12px system-ui';
      ctx.fillText(item.label, x, height - 6);
      nextBars.push({
        x,
        y: item.value >= 0 ? y : baselineY,
        width: barWidth,
        height: barHeightPx,
        label: item.label,
        value: item.value,
        color: item.color
      });
    });
    barRef.current = nextBars;
  }, [alt, height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleMove = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const x = (event.clientX - rect.left) * dpr;
      const y = (event.clientY - rect.top) * dpr;
      const hovered = barRef.current.find((bar) => {
        const bx = bar.x * dpr;
        const by = bar.y * dpr;
        const bw = bar.width * dpr;
        const bh = bar.height * dpr;
        return x >= bx && x <= bx + bw && y >= by && y <= by + bh;
      });
      if (!hovered) {
        setTooltip(null);
        return;
      }
      setTooltip({
        x: event.clientX - rect.left + 12,
        y: event.clientY - rect.top - 12,
        label: hovered.label,
        value: hovered.value,
        color: hovered.color
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
    <div className="relative">
      <canvas ref={canvasRef} className="w-full rounded-lg border border-slate-800 bg-slate-950" />
      {tooltip ? (
        <div className="tmm-chart-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
          <div className="tmm-chart-tooltip__title" style={{ color: tooltip.color }}>
            {tooltip.label}
          </div>
          <div className="tmm-chart-tooltip__meta">{formatCurrency(tooltip.value)}</div>
        </div>
      ) : null}
    </div>
  );
}
