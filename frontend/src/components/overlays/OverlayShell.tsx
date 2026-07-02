import React from 'react';

type OverlayShellProps = {
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
  actions?: React.ReactNode;
};

export function OverlayShell({ title, subtitle, children, actions }: OverlayShellProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 px-6">
      <div className="w-full max-w-xl rounded-2xl border border-slate-800 bg-slate-900 p-8 shadow-xl">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold text-white">{title}</h1>
          {subtitle ? <p className="text-sm text-slate-300">{subtitle}</p> : null}
        </div>
        {children ? <div className="mt-6 text-sm text-slate-200">{children}</div> : null}
        {actions ? <div className="mt-6 flex flex-wrap gap-3">{actions}</div> : null}
      </div>
    </div>
  );
}
