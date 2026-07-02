import { useState } from 'react';
import { OverlayShell } from './OverlayShell';
import { getSupabaseClient } from '../../lib/supabaseClient';

export function AuthScreen() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const submitMagicLink = async () => {
    if (!email.trim()) {
      setStatus('Enter a valid email.');
      return;
    }

    setIsSubmitting(true);
    setStatus(null);
    try {
      const { error } = await getSupabaseClient().auth.signInWithOtp({
        email: email.trim(),
        options: {
          emailRedirectTo: window.location.origin
        }
      });

      if (error) {
        setStatus('Sign-in failed. Please try again.');
        console.error('[auth] Magic link error', error);
      } else {
        setStatus('Check your email for a sign-in link.');
      }
    } catch (error) {
      console.error('[auth] Magic link exception', error);
      setStatus('Sign-in failed. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <OverlayShell
      title="Sign in to The Money Machine"
      subtitle="Continue with Google or request a magic link."
      actions={
        <button
          className="rounded-lg bg-slate-200 px-4 py-2 text-sm font-semibold text-slate-900"
          type="button"
          onClick={submitMagicLink}
          disabled={isSubmitting}
        >
          {isSubmitting ? 'Sending…' : 'Send magic link'}
        </button>
      }
    >
      <div className="space-y-4">
        <button
          className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
          type="button"
          onClick={async () => {
            try {
              await getSupabaseClient().auth.signInWithOAuth({
                provider: 'google',
                options: {
                  redirectTo: window.location.origin
                }
              });
            } catch (error) {
              console.error('[auth] Google sign-in failed', error);
              setStatus('Google sign-in failed. Please try again.');
            }
          }}
        >
          Continue with Google
        </button>
        <input
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        {status ? <div className="text-xs text-slate-300">{status}</div> : null}
      </div>
    </OverlayShell>
  );
}
