import { OverlayShell } from './OverlayShell';

type RestoreSessionOverlayProps = {
  reason?: string;
  metadata?: {
    lastSavedIso?: string | null;
    summary?: string;
    warning?: string;
  };
  onRestore?: () => void;
  onSkip?: () => void;
};

export function RestoreSessionOverlay({
  reason,
  metadata,
  onRestore,
  onSkip
}: RestoreSessionOverlayProps) {
  return (
    <OverlayShell
      title="Restore your last session"
      subtitle="Shown only when auth is ready and a restorable session exists."
      actions={
        <>
          <button
            className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-white"
            type="button"
            onClick={onRestore}
          >
            Restore session
          </button>
          <button
            className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200"
            type="button"
            onClick={onSkip}
          >
            Start fresh
          </button>
        </>
      }
    >
      <div className="space-y-2">
        {metadata?.summary ? <div>{metadata.summary}</div> : null}
        {metadata?.lastSavedIso ? (
          <div className="text-xs text-slate-400">Last saved: {metadata.lastSavedIso}</div>
        ) : null}
        {metadata?.warning ? <div className="text-xs text-amber-300">{metadata.warning}</div> : null}
        {reason ? <div className="text-xs text-slate-400">{reason}</div> : null}
      </div>
    </OverlayShell>
  );
}
