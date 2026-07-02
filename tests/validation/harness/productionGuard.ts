export type ProductionGuardInput = {
  plaidEnv: string;
  guardEnabled: boolean;
  acknowledged: boolean;
  estimatedCalls: number;
  maxCalls: number;
};

export function enforceProductionGuard(input: ProductionGuardInput) {
  const env = String(input.plaidEnv || '').toLowerCase();
  if (!input.guardEnabled) return;
  if (env !== 'production') return;
  if (!input.acknowledged) {
    throw new Error('PRODUCTION_GUARD: explicit acknowledgement required (set I_ACK_PROD=true).');
  }
  if (input.estimatedCalls > input.maxCalls) {
    throw new Error(
      `PRODUCTION_GUARD: estimated call count ${input.estimatedCalls} exceeds budget ${input.maxCalls}.`
    );
  }
}

export type CallTracker = {
  mode: 'mock' | 'sandbox' | 'production';
  calls: Array<{ method: string; endpoint: string; at: string }>;
  track: (method: string, endpoint: string) => void;
};

export function createCallTracker(mode: 'mock' | 'sandbox' | 'production'): CallTracker {
  const calls: Array<{ method: string; endpoint: string; at: string }> = [];
  return {
    mode,
    calls,
    track(method: string, endpoint: string) {
      calls.push({ method, endpoint, at: new Date().toISOString() });
      if (mode === 'mock') {
        throw new Error(`Mock mode must not call live Plaid endpoint: ${method} ${endpoint}`);
      }
    }
  };
}
