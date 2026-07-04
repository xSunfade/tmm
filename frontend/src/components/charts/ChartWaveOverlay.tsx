import { useEffect, useRef, useState } from 'react';

type ChartWaveOverlayProps = {
  active: boolean;
  label?: string;
};

type RibbonConfig = {
  lineCount: number;
  baseY: number;
  amplitude: number;
  frequency: number;
  phaseSpeed: number;
  lineSpread: number;
  opacity: number;
  colors: Array<{ stop: number; color: string }>;
};

const RIBBONS: RibbonConfig[] = [
  {
    lineCount: 22,
    baseY: 0.42,
    amplitude: 0.16,
    frequency: 2.4,
    phaseSpeed: 0.55,
    lineSpread: 1.4,
    opacity: 0.24,
    colors: [
      { stop: 0, color: 'rgba(217, 249, 157, 0.8)' },
      { stop: 0.45, color: 'rgba(52, 211, 153, 0.9)' },
      { stop: 1, color: 'rgba(6, 78, 59, 0.85)' }
    ]
  },
  {
    lineCount: 18,
    baseY: 0.52,
    amplitude: 0.13,
    frequency: 3.1,
    phaseSpeed: -0.42,
    lineSpread: 1.2,
    opacity: 0.2,
    colors: [
      { stop: 0, color: 'rgba(134, 239, 172, 0.75)' },
      { stop: 0.5, color: 'rgba(45, 212, 191, 0.88)' },
      { stop: 1, color: 'rgba(20, 83, 45, 0.82)' }
    ]
  },
  {
    lineCount: 20,
    baseY: 0.58,
    amplitude: 0.11,
    frequency: 2.8,
    phaseSpeed: 0.38,
    lineSpread: 1.1,
    opacity: 0.18,
    colors: [
      { stop: 0, color: 'rgba(110, 231, 183, 0.7)' },
      { stop: 0.55, color: 'rgba(16, 185, 129, 0.85)' },
      { stop: 1, color: 'rgba(4, 120, 87, 0.8)' }
    ]
  },
  {
    lineCount: 14,
    baseY: 0.35,
    amplitude: 0.09,
    frequency: 3.6,
    phaseSpeed: -0.48,
    lineSpread: 0.9,
    opacity: 0.16,
    colors: [
      { stop: 0, color: 'rgba(187, 247, 208, 0.6)' },
      { stop: 0.6, color: 'rgba(74, 222, 128, 0.78)' },
      { stop: 1, color: 'rgba(22, 101, 52, 0.72)' }
    ]
  }
];

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  return reduced;
}

function drawRibbon(
  ctx: CanvasRenderingContext2D,
  ribbon: RibbonConfig,
  width: number,
  height: number,
  time: number,
  animate: boolean
) {
  const gradient = ctx.createLinearGradient(0, 0, width, 0);
  ribbon.colors.forEach(({ stop, color }) => gradient.addColorStop(stop, color));

  for (let line = 0; line < ribbon.lineCount; line += 1) {
    const lineOffset = (line - ribbon.lineCount / 2) * ribbon.lineSpread;
    const linePhase = animate ? time * ribbon.phaseSpeed + line * 0.11 : line * 0.11;
    const lineOpacity = ribbon.opacity * (0.55 + 0.45 * Math.abs(Math.sin(line * 0.37)));

    ctx.beginPath();
    const steps = Math.max(48, Math.ceil(width / 3));
    for (let step = 0; step <= steps; step += 1) {
      const x = (step / steps) * width;
      const nx = x / width;
      const envelope = Math.sin(nx * Math.PI) * (0.35 + 0.65 * (1 - nx * 0.45));
      const wave =
        Math.sin(Math.PI * 2 * ribbon.frequency * nx + linePhase) * 0.72 +
        Math.sin(Math.PI * 2 * (ribbon.frequency * 0.55) * nx - linePhase * 0.6) * 0.28;
      const y = ribbon.baseY * height + envelope * ribbon.amplitude * height * wave + lineOffset;

      if (step === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }

    ctx.strokeStyle = gradient;
    ctx.globalAlpha = lineOpacity;
    ctx.lineWidth = 0.65;
    ctx.lineCap = 'round';
    ctx.stroke();
  }
}

export function ChartWaveOverlay({ active, label = 'Updating projection…' }: ChartWaveOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const prefersReducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    if (!active) return undefined;

    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return undefined;

    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;

    let width = 0;
    let height = 0;
    let dpr = 1;

    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      width = container.clientWidth;
      height = container.clientHeight;
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    const render = (timestamp: number) => {
      const animate = !prefersReducedMotion;
      const time = timestamp / 1000;
      ctx.clearRect(0, 0, width, height);
      RIBBONS.forEach((ribbon) => drawRibbon(ctx, ribbon, width, height, time, animate));
      ctx.globalAlpha = 1;
      rafRef.current = window.requestAnimationFrame(render);
    };

    rafRef.current = window.requestAnimationFrame(render);

    return () => {
      observer.disconnect();
      if (rafRef.current) window.cancelAnimationFrame(rafRef.current);
    };
  }, [active, prefersReducedMotion]);

  if (!active) return null;

  return (
    <div
      ref={containerRef}
      className="chart-wave-overlay absolute inset-0 z-40 overflow-hidden rounded-lg"
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <div className="chart-wave-overlay__veil absolute inset-0" />
      <canvas ref={canvasRef} className="chart-wave-overlay__canvas absolute inset-0 h-full w-full" aria-hidden />
      <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
        <span className="chart-wave-overlay__label rounded-full px-3 py-1 text-[11px] font-medium tracking-wide">
          {label}
        </span>
      </div>
    </div>
  );
}
