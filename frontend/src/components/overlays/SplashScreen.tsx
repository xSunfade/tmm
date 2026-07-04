import { useEffect, useMemo, useRef, useState } from 'react';
import logoTransparent from '../../assets/branding/tmm-text-logo-transparent.png';
import { SplashFeaturePreview } from './SplashFeaturePreview';

type SplashScreenProps = {
  mode?: 'loading' | 'unauthenticated';
  onLoginClick?: () => void;
  onCreateAccountClick?: () => void;
};

type Point = { x: number; y: number };

type TwinkleStar = {
  id: number;
  left: number;
  top: number;
  size: number;
  delay: number;
  duration: number;
  color: string;
};

type ShootingStar = {
  id: number;
  top: number;
  left: number;
  angle: number;
  length: number;
  duration: number;
  color: string;
  tailColor: string;
};

const TWINKLE_COLORS = ['#fff7b4', '#fde68a', '#bbf7d0', '#7dd3fc', '#fef08a', '#c4b5fd', '#fda4af'];

const SHOOTING_STAR_PALETTE = [
  { color: '#6ee7b7', tailColor: 'rgba(16, 185, 129, 0)' },
  { color: '#7dd3fc', tailColor: 'rgba(56, 189, 248, 0)' },
  { color: '#fcd34d', tailColor: 'rgba(251, 191, 36, 0)' },
  { color: '#c4b5fd', tailColor: 'rgba(167, 139, 250, 0)' },
  { color: '#fda4af', tailColor: 'rgba(244, 114, 182, 0)' }
];

function createTwinkleStars(count: number): TwinkleStar[] {
  return Array.from({ length: count }, (_, index) => {
    const seed = index * 7919 + 104729;
    return {
      id: index,
      left: ((seed * 73) % 980) / 10 + 1,
      top: ((seed * 179) % 960) / 10 + 2,
      size: 1 + ((seed * 13) % 12) / 10,
      delay: ((seed * 31) % 9000) / 1000,
      duration: 2.2 + ((seed * 17) % 3800) / 1000,
      color: TWINKLE_COLORS[seed % TWINKLE_COLORS.length]
    };
  });
}

const TWINKLE_STARS = createTwinkleStars(72);

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
  const starsRef = useRef<HTMLDivElement>(null);
  const starsOffsetRef = useRef<Point>({ x: 0, y: 0 });
  const starsTargetRef = useRef<Point>({ x: 0, y: 0 });
  const rafRef = useRef<number | null>(null);
  const shootingStarIdRef = useRef(0);
  const [shootingStars, setShootingStars] = useState<ShootingStar[]>([]);

  useEffect(() => {
    if (prefersReducedMotion) return undefined;
    const handleMove = (event: MouseEvent) => {
      starsTargetRef.current = {
        x: (event.clientX / window.innerWidth - 0.5) * 28,
        y: (event.clientY / window.innerHeight - 0.5) * 28
      };
    };

    const tick = () => {
      const target = starsTargetRef.current;
      const prev = starsOffsetRef.current;
      const next = {
        x: prev.x + (target.x - prev.x) * 0.07,
        y: prev.y + (target.y - prev.y) * 0.07
      };
      starsOffsetRef.current = next;
      starsRef.current?.style.setProperty(
        'transform',
        `translate3d(${next.x}px, ${next.y}px, 0)`
      );
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

  useEffect(() => {
    if (prefersReducedMotion) return undefined;

    const spawnShootingStar = () => {
      const palette = SHOOTING_STAR_PALETTE[Math.floor(Math.random() * SHOOTING_STAR_PALETTE.length)];
      shootingStarIdRef.current += 1;
      setShootingStars((prev) => [
        ...prev.slice(-5),
        {
          id: shootingStarIdRef.current,
          top: Math.random() * 42 + 2,
          left: Math.random() * 62 + 4,
          angle: -(34 + Math.random() * 22),
          length: 96 + Math.random() * 72,
          duration: 0.85 + Math.random() * 0.55,
          color: palette.color,
          tailColor: palette.tailColor
        }
      ]);
    };

    spawnShootingStar();
    const interval = window.setInterval(spawnShootingStar, 1800 + Math.random() * 2200);

    return () => window.clearInterval(interval);
  }, [prefersReducedMotion]);

  const removeShootingStar = (id: number) => {
    setShootingStars((prev) => prev.filter((star) => star.id !== id));
  };

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

  return (
    <div className="tmm-splash-concept relative min-h-screen overflow-hidden bg-slate-950 text-slate-200">
      <div className="tmm-splash-concept__ambient" aria-hidden />
      <div className="tmm-splash-concept__veil" />
      <div ref={starsRef} className="tmm-splash-starfield" aria-hidden>
        <div className="tmm-splash-concept__stars tmm-splash-concept__stars--shimmer" />
        <div className="tmm-splash-starfield__twinkles">
          {TWINKLE_STARS.map((star) => (
            <span
              key={star.id}
              className="tmm-splash-starfield__twinkle"
              style={{
                left: `${star.left}%`,
                top: `${star.top}%`,
                width: `${star.size}px`,
                height: `${star.size}px`,
                color: star.color,
                backgroundColor: star.color,
                animationDelay: `${star.delay}s`,
                animationDuration: `${star.duration}s`
              }}
            />
          ))}
        </div>
        <div className="tmm-splash-starfield__shooting">
          {!prefersReducedMotion
            ? shootingStars.map((star) => (
                <span
                  key={star.id}
                  className="tmm-splash-starfield__shooting-star"
                  style={{
                    top: `${star.top}%`,
                    left: `${star.left}%`,
                    width: `${star.length}px`,
                    ['--shoot-angle' as string]: `${star.angle}deg`,
                    ['--shoot-color' as string]: star.color,
                    ['--shoot-tail' as string]: star.tailColor,
                    animationDuration: `${star.duration}s`
                  }}
                  onAnimationEnd={() => removeShootingStar(star.id)}
                />
              ))
            : null}
        </div>
      </div>
      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-6xl items-center justify-center px-4 py-9 sm:px-8 lg:px-12">
        <div className="flex w-full flex-col items-center gap-4 sm:gap-5">
          <section className="tmm-splash-concept__hero relative w-full max-w-[340px] rounded-2xl border border-emerald-300/18 px-4 py-4 text-center sm:max-w-[360px] sm:px-5 sm:py-5">
            <div className="tmm-splash-concept__hero-glow" />
            <img
              src={logoTransparent}
              alt="The Money Machine"
              className="relative z-10 mx-auto w-full max-w-[280px] drop-shadow-[0_10px_28px_rgba(2,6,23,0.7)] sm:max-w-[300px]"
            />
            <p className="relative z-10 mt-2.5 text-sm text-slate-100/92">{text.subtitle}</p>
            {mode === 'unauthenticated' ? (
              <div className="relative z-10 mt-4 flex flex-col items-center gap-2">
                <button
                  className="w-full max-w-[220px] rounded-md border border-emerald-300/70 bg-gradient-to-b from-emerald-300/75 via-emerald-400/78 to-emerald-600/72 px-4 py-1.5 text-sm font-semibold tracking-wide text-slate-950 shadow-[0_10px_28px_rgba(16,185,129,0.45)] transition hover:brightness-110"
                  type="button"
                  onClick={onLoginClick}
                >
                  LOG IN
                </button>
                <button
                  className="w-full max-w-[220px] rounded-md border border-slate-100/25 bg-slate-950/46 px-4 py-1.5 text-sm font-semibold tracking-wide text-slate-100 transition hover:bg-slate-900/66"
                  type="button"
                  onClick={onCreateAccountClick ?? onLoginClick}
                >
                  CREATE FREE ACCOUNT
                </button>
              </div>
            ) : (
              <div className="relative z-10 mt-4 inline-flex items-center gap-2 rounded-md border border-emerald-300/40 bg-emerald-500/15 px-3 py-1 text-xs text-emerald-100">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-300 animate-pulse" />
                Loading secure workspace...
              </div>
            )}
          </section>

          <SplashFeaturePreview />
        </div>
      </div>
    </div>
  );
}
