import { useEffect, useMemo, useRef, useState } from 'react';
import logoDarkGreen from '../../assets/branding/tmm-text-logo-dark-green.png';
import logoWhite from '../../assets/branding/tmm-text-logo-white.png';
import splashConceptBackground from '../../assets/splash/splash-concept-centered.png';

type SplashScreenProps = {
  mode?: 'loading' | 'unauthenticated';
  onLoginClick?: () => void;
  onCreateAccountClick?: () => void;
};

type Point = { x: number; y: number };

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches);
    update();
    if (media.addEventListener) {
      media.addEventListener('change', update);
      return () => media.removeEventListener('change', update);
    }
    media.addListener(update);
    return () => media.removeListener(update);
  }, []);

  return reduced;
}

export function SplashScreen({ mode = 'loading', onLoginClick, onCreateAccountClick }: SplashScreenProps) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const targetRef = useRef<Point>({ x: 0, y: 0 });
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (prefersReducedMotion) return undefined;
    const handleMove = (event: MouseEvent) => {
      const x = (event.clientX / window.innerWidth - 0.5) * 16;
      const y = (event.clientY / window.innerHeight - 0.5) * 16;
      targetRef.current = { x, y };
    };

    const tick = () => {
      const current = targetRef.current;
      setOffset((prev) => ({
        x: prev.x + (current.x - prev.x) * 0.08,
        y: prev.y + (current.y - prev.y) * 0.08
      }));
      rafRef.current = window.requestAnimationFrame(tick);
    };

    window.addEventListener('mousemove', handleMove);
    rafRef.current = window.requestAnimationFrame(tick);

    return () => {
      window.removeEventListener('mousemove', handleMove);
      if (rafRef.current) {
        window.cancelAnimationFrame(rafRef.current);
      }
    };
  }, [prefersReducedMotion]);

  const text = useMemo(() => {
    if (mode === 'unauthenticated') {
      return {
        subtitle: 'Simulate the future of your money.'
      };
    }
    return {
      subtitle: 'Initializing the workspace and preparing your plan.'
    };
  }, [mode]);

  const baseOffset = prefersReducedMotion ? { x: 0, y: 0 } : offset;
  const bgOffset = { x: baseOffset.x * 0.32, y: baseOffset.y * 0.32 };
  const starsOffset = { x: baseOffset.x * 0.5, y: baseOffset.y * 0.5 };
  const coreOffset = { x: baseOffset.x * 0.75, y: baseOffset.y * 0.75 };
  const logoSrc = mode === 'loading' ? logoWhite : logoDarkGreen;

  return (
    <div className="tmm-splash-concept relative min-h-screen overflow-hidden bg-slate-950 text-slate-200">
      <div
        className="tmm-splash-concept__bg"
        style={{
          backgroundImage: `url(${splashConceptBackground})`,
          transform: `translate3d(${bgOffset.x}px, ${bgOffset.y}px, 0) scale(1.15)`
        }}
      />
      <div className="tmm-splash-concept__veil" />
      <div
        className="tmm-splash-concept__stars"
        style={{ transform: `translate3d(${starsOffset.x}px, ${starsOffset.y}px, 0)` }}
      />
      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-6xl items-center justify-center px-4 py-9 sm:px-8 lg:px-12">
        <div
          className="flex w-full flex-col items-center gap-4 sm:gap-5"
          style={{ transform: `translate3d(${coreOffset.x}px, ${coreOffset.y}px, 0)` }}
        >
          <section className="tmm-splash-concept__hero relative w-full max-w-[460px] rounded-3xl border border-emerald-300/18 px-4 py-5 text-center sm:px-6 sm:py-7">
            <div className="tmm-splash-concept__hero-glow" />
            <img
              src={logoSrc}
              alt="The Money Machine"
              className="relative z-10 mx-auto w-full max-w-[390px] drop-shadow-[0_10px_28px_rgba(2,6,23,0.7)]"
            />
            <p className="relative z-10 mt-3 text-sm text-slate-100/92 sm:text-base">{text.subtitle}</p>
            {mode === 'unauthenticated' ? (
              <div className="relative z-10 mt-5 flex flex-col items-center gap-2.5">
                <button
                  className="w-full max-w-[260px] rounded-md border border-emerald-300/70 bg-gradient-to-b from-emerald-300/75 via-emerald-400/78 to-emerald-600/72 px-5 py-2 text-sm font-semibold tracking-wide text-slate-950 shadow-[0_10px_28px_rgba(16,185,129,0.45)] transition hover:brightness-110"
                  type="button"
                  onClick={onLoginClick}
                >
                  LOG IN
                </button>
                <button
                  className="w-full max-w-[260px] rounded-md border border-slate-100/25 bg-slate-950/46 px-5 py-2 text-sm font-semibold tracking-wide text-slate-100 transition hover:bg-slate-900/66"
                  type="button"
                  onClick={onCreateAccountClick ?? onLoginClick}
                >
                  CREATE FREE ACCOUNT
                </button>
              </div>
            ) : (
              <div className="relative z-10 mt-5 inline-flex items-center gap-2 rounded-md border border-emerald-300/40 bg-emerald-500/15 px-3 py-1 text-xs text-emerald-100">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-300 animate-pulse" />
                Loading secure workspace...
              </div>
            )}
          </section>

          <section
            className="tmm-splash-concept__preview relative mx-auto w-full max-w-[840px] rounded-2xl border border-slate-100/16 bg-slate-950/72 p-3 shadow-[0_34px_90px_rgba(2,6,23,0.72)] backdrop-blur-md sm:p-4"
            aria-label="Example projection preview"
          >
            <div className="mb-2.5 flex items-center justify-between text-[11px] text-slate-300/90">
              <span className="font-semibold">Example Projection</span>
              <div className="flex items-center gap-3 text-[10px]">
                <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-cyan-300" />Baseline</span>
                <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-300" />Growth</span>
                <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-300" />Conservative</span>
              </div>
            </div>
            <div className="relative h-52 overflow-hidden rounded-xl border border-slate-200/10 bg-gradient-to-b from-slate-900/95 to-slate-950/95 sm:h-60">
              <svg className="absolute inset-0 h-full w-full" viewBox="0 0 820 300" aria-hidden>
                <defs>
                  <linearGradient id="gridline" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="#9ca3af" stopOpacity="0.26" />
                    <stop offset="1" stopColor="#9ca3af" stopOpacity="0.07" />
                  </linearGradient>
                </defs>
                <path d="M40 260H780M40 214H780M40 168H780M40 122H780M40 76H780M40 30H780" stroke="url(#gridline)" strokeWidth="1" />
                <path d="M40 246L164 232L287 210L411 178L534 142L658 98L780 55" stroke="#7dd3fc" strokeWidth="3" fill="none" strokeLinecap="round" />
                <path d="M40 250L164 238L287 222L411 196L534 158L658 120L780 76" stroke="#4ade80" strokeWidth="3" fill="none" strokeLinecap="round" />
                <path d="M40 255L164 248L287 236L411 217L534 188L658 154L780 118" stroke="#fbbf24" strokeWidth="3" fill="none" strokeLinecap="round" />
                <circle cx="658" cy="98" r="4.5" fill="#7dd3fc" />
                <circle cx="658" cy="120" r="4.5" fill="#4ade80" />
                <circle cx="658" cy="154" r="4.5" fill="#fbbf24" />
              </svg>
              <div className="absolute bottom-2 left-2 right-2 flex justify-between text-[10px] text-slate-300/75">
                <span>8/2026</span>
                <span>8/2036</span>
                <span>8/2046</span>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-slate-300 sm:grid-cols-4">
              <div className="rounded-lg border border-emerald-300/20 bg-emerald-300/10 px-2 py-1.5">Assets</div>
              <div className="rounded-lg border border-cyan-300/20 bg-cyan-300/10 px-2 py-1.5">Income</div>
              <div className="rounded-lg border border-rose-300/20 bg-rose-300/10 px-2 py-1.5">Debt</div>
              <div className="rounded-lg border border-amber-300/20 bg-amber-300/10 px-2 py-1.5">Investments</div>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[10px] text-slate-300/88">
              <span>Build flows</span>
              <span>Simulate outcomes</span>
              <span>Optimize growth</span>
              <span>Connect accounts</span>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
