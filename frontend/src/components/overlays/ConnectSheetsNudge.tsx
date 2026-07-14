import { OverlayShell } from './OverlayShell';

type ConnectSheetsNudgeProps = {
  onConnect?: () => void;
  onDismiss?: () => void;
  onOpenLegacy?: () => void;
};

export function ConnectSheetsNudge({ onConnect, onDismiss, onOpenLegacy }: ConnectSheetsNudgeProps) {
  return (
    <OverlayShell
      title="Connect Google Sheets (Beta)"
      subtitle="Optional backup — your plan is already saved to your account."
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
      <div>
        Export a copy of your plan to a Google Sheet you own, or import one back into TMM. This is a
        separate Google permission covering only Sheets — you can connect or revoke it anytime.
      </div>
    </OverlayShell>
  );
}
