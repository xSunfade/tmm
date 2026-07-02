import { useEffect, useMemo, useState } from 'react';
import { isRoute, navigateToRoute, usePathname } from '../../app/routing';
import type { TourStep } from '../../features/tour/tourTypes';
import { getTourState, nextStep, prevStep, skipTour, subscribeTour, completeTour } from '../../features/tour/tourManager';

type Rect = { top: number; left: number; width: number; height: number };

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getTooltipPosition(rect: Rect | null, position: TourStep['position']) {
  const padding = 16;
  const width = 320;
  const height = 160;
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;

  if (!rect) {
    return {
      left: (viewportW - width) / 2,
      top: (viewportH - height) / 2
    };
  }

  const base = {
    left: rect.left + rect.width + padding,
    top: rect.top + rect.height / 2 - height / 2
  };

  switch (position) {
    case 'left':
      base.left = rect.left - width - padding;
      base.top = rect.top + rect.height / 2 - height / 2;
      break;
    case 'top':
      base.left = rect.left + rect.width / 2 - width / 2;
      base.top = rect.top - height - padding;
      break;
    case 'bottom':
      base.left = rect.left + rect.width / 2 - width / 2;
      base.top = rect.top + rect.height + padding;
      break;
    case 'top-right':
      base.left = rect.left + rect.width + padding;
      base.top = rect.top - height - padding;
      break;
    case 'bottom-right':
      base.left = rect.left + rect.width + padding;
      base.top = rect.top + rect.height + padding;
      break;
    default:
      break;
  }

  return {
    left: clamp(base.left, padding, viewportW - width - padding),
    top: clamp(base.top, padding, viewportH - height - padding)
  };
}

export function TourSpotlightOverlay({ onExit }: { onExit: () => void }) {
  const pathname = usePathname();
  const [tourState, setTourState] = useState(getTourState());
  const [targetRect, setTargetRect] = useState<Rect | null>(null);
  const [isWaiting, setIsWaiting] = useState(false);

  const step = tourState.steps[tourState.currentIndex];
  const isActive = tourState.status === 'active' && !!step;

  useEffect(() => {
    const unsub = subscribeTour(setTourState);
    return () => {
      unsub();
    };
  }, []);

  useEffect(() => {
    if (!isActive || !step) return;

    if (step.route && !isRoute(pathname, step.route)) {
      navigateToRoute(step.route);
    }
  }, [isActive, pathname, step]);

  useEffect(() => {
    if (!isActive || !step) return;
    let attempts = 0;
    const maxAttempts = 40;

    const updateRect = () => {
      const element = document.querySelector(step.target) as HTMLElement | null;
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      if (rect.top < 0 || rect.bottom > window.innerHeight) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
    };

    const interval = window.setInterval(() => {
      const nextRect = updateRect();
      if (nextRect) {
        setTargetRect(nextRect);
      } else if (attempts++ > maxAttempts) {
        setTargetRect(null);
      }
    }, 150);

    const handleResize = () => {
      const nextRect = updateRect();
      setTargetRect(nextRect);
    };

    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', handleResize, true);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', handleResize, true);
    };
  }, [isActive, step]);

  useEffect(() => {
    if (!isActive || !step?.waitFor) {
      setIsWaiting(false);
      return;
    }

    let raf = 0;
    const tick = () => {
      const ready = step.waitFor?.() ?? false;
      setIsWaiting(!ready);
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [isActive, step]);

  const tooltipPosition = useMemo(() => getTooltipPosition(targetRect, step?.position), [targetRect, step?.position]);

  if (!isActive || !step) {
    return null;
  }

  const padding = 12;
  const highlightStyle = targetRect
    ? {
        top: targetRect.top - padding,
        left: targetRect.left - padding,
        width: targetRect.width + padding * 2,
        height: targetRect.height + padding * 2
      }
    : null;

  return (
    <div className="pointer-events-none fixed inset-0 z-[60]">
      {highlightStyle ? (
        <div
          className="pointer-events-none absolute rounded-2xl border border-emerald-400/50"
          style={{
            ...highlightStyle,
            boxShadow: '0 0 0 9999px rgba(2, 6, 23, 0.7)',
            background: 'rgba(15, 23, 42, 0.15)'
          }}
        />
      ) : (
        <div className="absolute inset-0 bg-slate-950/70" />
      )}

      <div
        className="pointer-events-auto absolute w-[320px] rounded-2xl border border-slate-700 bg-slate-950/95 p-4 text-sm text-slate-100 shadow-[0_0_30px_rgba(15,23,42,0.6)]"
        style={{ left: tooltipPosition.left, top: tooltipPosition.top }}
      >
        <div className="text-xs uppercase tracking-[0.3em] text-emerald-200">Guided Tour</div>
        <div className="mt-2 text-lg font-semibold text-white">{step.title}</div>
        <div className="mt-2 text-sm text-slate-300">{step.description}</div>
        {step.action ? (
          <div className="mt-3 text-xs text-emerald-200">
            {step.action === 'click' ? 'Action: click the highlighted control.' : 'Action: review this area.'}
          </div>
        ) : null}
        <div className="mt-4 flex items-center justify-between gap-3 text-xs text-slate-400">
          <span>
            Step {tourState.currentIndex + 1} of {tourState.steps.length}
          </span>
          <div className="flex items-center gap-2">
            <button
              className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300"
              type="button"
              onClick={() => {
                skipTour();
                onExit();
              }}
            >
              Skip
            </button>
            {tourState.currentIndex > 0 ? (
              <button
                className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-200"
                type="button"
                onClick={prevStep}
              >
                Back
              </button>
            ) : null}
            <button
              className="rounded bg-emerald-500 px-3 py-1 text-xs font-semibold text-slate-950 disabled:opacity-60"
              type="button"
              onClick={() => {
                if (tourState.currentIndex >= tourState.steps.length - 1) {
                  completeTour();
                  onExit();
                } else {
                  nextStep();
                }
              }}
              disabled={isWaiting}
            >
              {tourState.currentIndex >= tourState.steps.length - 1 ? 'Finish' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
