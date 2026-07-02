import { OverlayShell } from './OverlayShell';

type ConnectSheetsNudgeProps = {
  onConnect?: () => void;
  onDismiss?: () => void;
  onOpenLegacy?: () => void;
};

export function ConnectSheetsNudge({ onConnect, onDismiss, onOpenLegacy }: ConnectSheetsNudgeProps) {
  return (
    <OverlayShell
      title="Connect Google Sheets"
      subtitle="Connect now or continue in local-first mode."
      actions={
        <>
          <button
            className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold text-white"
            type="button"
            onClick={() => {
              onConnect?.();
            }}
          >
            CONNECT SHEETS
          </button>
          {onOpenLegacy ? (
            <button
              className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200"
              type="button"
              onClick={() => {
                onOpenLegacy?.();
              }}
            >
              Open legacy connect flow
            </button>
          ) : null}
          <button
            className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200"
            type="button"
            onClick={() => {
              onDismiss?.();
            }}
          >
            Not now
          </button>
        </>
      }
    >
      <div>Your plan can sync to Sheets for backup and collaboration. You can connect anytime.</div>
    </OverlayShell>
  );
}
