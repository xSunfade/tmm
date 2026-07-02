import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getSupabaseClient } from '../../lib/supabaseClient';

type SplashLoginOverlayProps = {
  onClose?: () => void;
  initialIntent?: 'login' | 'signup';
};

type PendingAuth = { type: 'google' } | { type: 'email'; email: string };
type OAuthSignInOptions = {
  redirectTo?: string;
  scopes?: string;
  queryParams?: { [key: string]: string };
  skipBrowserRedirect?: boolean;
};

export function SplashLoginOverlay({ onClose, initialIntent = 'login' }: SplashLoginOverlayProps) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string>('');
  const [cooldownUntil, setCooldownUntil] = useState<number>(0);
  const [attemptCount, setAttemptCount] = useState(0);
  const widgetRef = useRef<HTMLDivElement | null>(null);
  const turnstileIdRef = useRef<string | null>(null);
  const pendingAuthRef = useRef<PendingAuth | null>(null);
  const captchaSiteKey = (import.meta.env.VITE_AUTH_CAPTCHA_SITE_KEY as string | undefined) || '';
  const nowMs = Date.now();
  const inCooldown = cooldownUntil > nowMs;
  const cooldownSeconds = inCooldown ? Math.max(1, Math.ceil((cooldownUntil - nowMs) / 1000)) : 0;

  const nextBackoffMs = useMemo(() => {
    const exponent = Math.min(5, Math.max(0, attemptCount));
    return Math.min(30_000, 1000 * (2 ** exponent));
  }, [attemptCount]);

  useEffect(() => {
    if (!captchaSiteKey || (window as any)?.turnstile) return;
    const existing = document.getElementById('cf-turnstile-script');
    if (existing) return;
    const script = document.createElement('script');
    script.id = 'cf-turnstile-script';
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);
  }, [captchaSiteKey]);

  const runPendingAuth = useCallback(async (token: string) => {
    const pending = pendingAuthRef.current;
    pendingAuthRef.current = null;
    if (!pending) return;
    setStatus(null);
    setIsSubmitting(true);
    try {
      if (pending.type === 'google') {
        const oauthOptions = {
          redirectTo: window.location.origin,
          captchaToken: token
        } as OAuthSignInOptions;
        const { error } = await getSupabaseClient().auth.signInWithOAuth({
          provider: 'google',
          options: oauthOptions
        });
        if (error) throw error;
      } else {
        const { error } = await getSupabaseClient().auth.signInWithOtp({
          email: pending.email,
          options: {
            emailRedirectTo: window.location.origin,
            captchaToken: token
          }
        });
        if (error) throw error;
        setStatus('Check your email for a sign-in link.');
        setAttemptCount(0);
        setCooldownUntil(0);
      }
    } catch (error) {
      const msg = String(error ?? '');
      const isCaptcha = msg.includes('captcha_failed') || msg.toLowerCase().includes('captcha');
      setStatus(isCaptcha ? 'CAPTCHA verification failed. Please try again.' : 'Sign-in failed. Please try again.');
      setAttemptCount((prev) => prev + 1);
      setCooldownUntil(Date.now() + nextBackoffMs);
      console.error('[auth] Sign-in error', error);
    } finally {
      setIsSubmitting(false);
    }
  }, [nextBackoffMs]);

  useEffect(() => {
    const maybeTurnstile = (window as any)?.turnstile;
    if (!captchaSiteKey || !maybeTurnstile || !widgetRef.current || turnstileIdRef.current) return;
    turnstileIdRef.current = maybeTurnstile.render(widgetRef.current, {
      sitekey: captchaSiteKey,
      appearance: 'interaction-only',
      size: 'invisible',
      execution: 'execute',
      callback: (token: string) => {
        setCaptchaToken(token);
        runPendingAuth(token);
      },
      'expired-callback': () => setCaptchaToken(''),
      'error-callback': () => {
        setCaptchaToken('');
        if (pendingAuthRef.current) {
          setStatus('Verification failed. Please try again.');
          pendingAuthRef.current = null;
          setIsSubmitting(false);
        }
      }
    });
  }, [captchaSiteKey, runPendingAuth]);

  const extractAuthErrorCode = (error: unknown): string => {
    const msg = String(error || '');
    if (msg.includes('captcha_failed') || msg.toLowerCase().includes('captcha')) return 'captcha_failed';
    return 'auth_error';
  };

  const submitMagicLink = async () => {
    if (inCooldown) {
      setStatus(`Please wait ${cooldownSeconds}s before trying again.`);
      return;
    }
    if (!email.trim()) {
      setStatus('Enter a valid email.');
      return;
    }
    setStatus(null);
    const turnstile = (window as any)?.turnstile;
    if (captchaSiteKey && turnstile && turnstileIdRef.current != null) {
      if (captchaToken) {
        setIsSubmitting(true);
        try {
          const { error } = await getSupabaseClient().auth.signInWithOtp({
            email: email.trim(),
            options: {
              emailRedirectTo: window.location.origin,
              captchaToken
            }
          });
          if (error) throw error;
          setStatus('Check your email for a sign-in link.');
          setAttemptCount(0);
          setCooldownUntil(0);
        } catch (error) {
          const code = extractAuthErrorCode(error);
          setStatus(code === 'captcha_failed' ? 'CAPTCHA verification failed. Please retry.' : 'Sign-in failed. Please try again.');
          setAttemptCount((prev) => prev + 1);
          setCooldownUntil(Date.now() + nextBackoffMs);
          console.error('[auth] Magic link error', error);
        } finally {
          setIsSubmitting(false);
        }
      } else {
        pendingAuthRef.current = { type: 'email', email: email.trim() };
        setIsSubmitting(true);
        turnstile.execute('#turnstile-auth-widget');
      }
      return;
    }
    setIsSubmitting(true);
    try {
      const { error } = await getSupabaseClient().auth.signInWithOtp({
        email: email.trim(),
        options: { emailRedirectTo: window.location.origin }
      });
      if (error) throw error;
      setStatus('Check your email for a sign-in link.');
      setAttemptCount(0);
      setCooldownUntil(0);
    } catch (error) {
      console.error('[auth] Magic link exception', error);
      setStatus('Sign-in failed. Please try again.');
      setAttemptCount((prev) => prev + 1);
      setCooldownUntil(Date.now() + nextBackoffMs);
    } finally {
      setIsSubmitting(false);
    }
  };

  const heroTitle = initialIntent === 'signup' ? 'Create your free account.' : 'Sign in to continue.';
  const heroSubTitle = initialIntent === 'signup'
    ? 'Start building your plan in minutes. No card required.'
    : 'Pick Google or magic link to access your workspace securely.';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-8 backdrop-blur-md sm:px-6">
      <div className="relative w-full max-w-2xl overflow-hidden rounded-3xl border border-emerald-300/20 bg-slate-950/75 p-6 text-slate-100 shadow-[0_30px_80px_rgba(2,6,23,0.72)] backdrop-blur-xl sm:p-8">
        <div className="pointer-events-none absolute inset-0 opacity-80">
          <div className="absolute -left-28 top-0 h-60 w-60 rounded-full bg-emerald-400/20 blur-3xl" />
          <div className="absolute -right-20 bottom-0 h-56 w-56 rounded-full bg-cyan-400/15 blur-3xl" />
        </div>
        <div className="relative flex items-start justify-between gap-6">
          <div className="space-y-2">
            <div className="text-[11px] uppercase tracking-[0.35em] text-emerald-200/95">The Money Machine</div>
            <h1 className="text-2xl font-semibold text-white">{heroTitle}</h1>
            <p className="text-sm text-slate-300">{heroSubTitle}</p>
          </div>
          {onClose ? (
            <button
              className="rounded-full border border-white/20 px-3 py-1 text-xs text-slate-200 transition hover:bg-white/10"
              type="button"
              onClick={onClose}
            >
              Close
            </button>
          ) : null}
        </div>

        <div className="relative mt-6 space-y-4">
          <button
            className="w-full rounded-lg border border-emerald-300/55 bg-gradient-to-b from-emerald-300/45 to-emerald-500/45 px-4 py-2.5 text-sm font-semibold text-slate-950 shadow-[0_10px_25px_rgba(16,185,129,0.35)] transition hover:brightness-110 disabled:opacity-70"
            type="button"
            onClick={async () => {
              if (inCooldown) {
                setStatus(`Please wait ${cooldownSeconds}s before trying again.`);
                return;
              }
              setStatus(null);
              const turnstile = (window as any)?.turnstile;
              if (captchaSiteKey && turnstile && turnstileIdRef.current != null) {
                if (captchaToken) {
                  try {
                    const oauthOptions = {
                      redirectTo: window.location.origin,
                      captchaToken
                    } as OAuthSignInOptions;
                    const { error } = await getSupabaseClient().auth.signInWithOAuth({
                      provider: 'google',
                      options: oauthOptions
                    });
                    if (error) throw error;
                  } catch (error) {
                    console.error('[auth] Google sign-in failed', error);
                    setStatus('Google sign-in failed. Please try again.');
                    setAttemptCount((prev) => prev + 1);
                    setCooldownUntil(Date.now() + nextBackoffMs);
                  }
                } else {
                  pendingAuthRef.current = { type: 'google' };
                  setIsSubmitting(true);
                  turnstile.execute('#turnstile-auth-widget');
                }
                return;
              }
              try {
                const { error } = await getSupabaseClient().auth.signInWithOAuth({
                  provider: 'google',
                  options: { redirectTo: window.location.origin }
                });
                if (error) throw error;
              } catch (error) {
                console.error('[auth] Google sign-in failed', error);
                setStatus('Google sign-in failed. Please try again.');
                setAttemptCount((prev) => prev + 1);
                setCooldownUntil(Date.now() + nextBackoffMs);
              }
            }}
            disabled={inCooldown || isSubmitting}
          >
            {inCooldown ? `Try again in ${cooldownSeconds}s` : isSubmitting ? 'Verifying…' : 'Continue with Google'}
          </button>

          <div className="space-y-2 rounded-xl border border-white/10 bg-slate-950/45 p-3.5 sm:p-4">
            <div id="turnstile-auth-widget" ref={widgetRef} aria-hidden="true" className="absolute opacity-0 pointer-events-none h-0 w-0 overflow-hidden" />
            {!captchaSiteKey ? (
              <input
                className="w-full rounded-lg border border-white/10 bg-slate-950/65 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500"
                type="text"
                placeholder="Optional captcha token (if enabled)"
                value={captchaToken}
                onChange={(event) => setCaptchaToken(event.target.value)}
              />
            ) : null}
            <input
              className="w-full rounded-lg border border-white/10 bg-slate-950/65 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <button
              className="w-full rounded-lg border border-white/20 bg-white/10 px-4 py-2.5 text-sm font-semibold text-slate-100 transition hover:bg-white/20 disabled:opacity-70"
              type="button"
              onClick={submitMagicLink}
              disabled={isSubmitting || inCooldown}
            >
              {isSubmitting ? 'Sending…' : inCooldown ? `Try again in ${cooldownSeconds}s` : 'Continue with Email'}
            </button>
          </div>

          <div className="rounded-lg border border-emerald-300/15 bg-emerald-500/10 px-3 py-2 text-xs text-slate-200">
            No bank access required. Your data stays in your Google Sheet. Local-first and privacy-respecting.
          </div>
          {status ? <div className="text-xs text-emerald-200">{status}</div> : null}
        </div>
      </div>
    </div>
  );
}
