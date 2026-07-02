import type { RestoreMetadata } from '../../state/appState';

type RestoreResult = {
  ok: boolean;
  error?: string;
};

type PendingRestore = {
  resolve: (result: RestoreResult) => void;
  timeoutId: number;
};

let legacyWindow: Window | null = null;
let legacyOrigin = '*';
let pendingRestore: PendingRestore | null = null;

// Future work (document only): Supabase-backed session snapshots (tmm_sessions), RLS,
// versioning, and offline/latency handling.

export function setLegacyFrameWindow(frame: Window | null, origin?: string) {
  legacyWindow = frame;
  legacyOrigin = origin || '*';
}

export function handleLegacyRestoreMessage(event: MessageEvent) {
  if (!pendingRestore) return;

  const data = event.data as { type?: string; error?: string } | null;
  if (!data || typeof data.type !== 'string') return;

  if (data.type === 'TMM_RESTORE_COMPLETE') {
    clearTimeout(pendingRestore.timeoutId);
    pendingRestore.resolve({ ok: true });
    pendingRestore = null;
    return;
  }

  if (data.type === 'TMM_RESTORE_ERROR') {
    clearTimeout(pendingRestore.timeoutId);
    pendingRestore.resolve({ ok: false, error: data.error || 'Unknown error' });
    pendingRestore = null;
  }
}

export function requestLegacyRestore(
  meta?: RestoreMetadata,
  timeoutMs = 8000
): Promise<RestoreResult> {
  if (!legacyWindow) {
    return Promise.resolve({ ok: false, error: 'Legacy iframe not available' });
  }

  if (pendingRestore) {
    return Promise.resolve({ ok: false, error: 'Restore already pending' });
  }

  return new Promise((resolve) => {
    const timeoutId = window.setTimeout(() => {
      pendingRestore = null;
      resolve({ ok: false, error: 'Restore timed out' });
    }, timeoutMs);

    pendingRestore = { resolve, timeoutId };
    if (!legacyWindow) {
      resolve({ ok: false, error: 'Legacy window unavailable' });
      return;
    }
    legacyWindow.postMessage(
      {
        type: 'TMM_RESTORE_SESSION',
        payload: meta ?? null
      },
      legacyOrigin
    );
  });
}
