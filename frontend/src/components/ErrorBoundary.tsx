import React from 'react';

type ErrorBoundaryProps = {
  children: React.ReactNode;
};

type ErrorBoundaryState = {
  hasError: boolean;
};

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[app] Uncaught render error', error, errorInfo);
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-slate-200">
        <div className="w-full max-w-md rounded-lg border border-slate-800 bg-slate-900/60 p-6 text-center" role="alert">
          <h1 className="text-lg font-semibold text-slate-100">Something went wrong</h1>
          <p className="mt-2 text-sm text-slate-400">
            The app hit an unexpected error. Your data is saved locally on this device, so reloading will not lose it.
          </p>
          <button
            type="button"
            className="mt-4 rounded-lg border border-emerald-500/70 bg-emerald-600/20 px-4 py-2 text-sm font-semibold text-emerald-100 hover:bg-emerald-600/30"
            onClick={() => window.location.reload()}
          >
            Reload app
          </button>
        </div>
      </div>
    );
  }
}
