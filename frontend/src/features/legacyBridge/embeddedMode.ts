type EmbeddedAck = {
  resolve: (value: boolean) => void;
  timeoutId: number;
};

let legacyWindow: Window | null = null;
let legacyOrigin = '*';
let pendingAck: EmbeddedAck | null = null;

export function setEmbeddedLegacyWindow(frame: Window | null, origin?: string) {
  legacyWindow = frame;
  legacyOrigin = origin || '*';
}

export function postLegacyMessage(message: Record<string, unknown>): boolean {
  if (!legacyWindow) {
    console.warn('[embedded] Legacy iframe not available for message', message.type);
    return false;
  }
  legacyWindow.postMessage(message, legacyOrigin);
  return true;
}

export function requestEmbeddedMode(enabled = true, timeoutMs = 3000): Promise<boolean> {
  if (!legacyWindow) {
    return Promise.resolve(false);
  }

  if (pendingAck) {
    clearTimeout(pendingAck.timeoutId);
    pendingAck = null;
  }

  return new Promise((resolve) => {
    const timeoutId = window.setTimeout(() => {
      pendingAck = null;
      resolve(false);
    }, timeoutMs);

    pendingAck = { resolve, timeoutId };
    postLegacyMessage({ type: 'TMM_EMBEDDED_MODE', enabled });
  });
}

export function handleEmbeddedModeMessage(event: MessageEvent) {
  if (!pendingAck) return;
  const data = event.data as { type?: string; enabled?: boolean } | null;
  if (!data || data.type !== 'TMM_EMBEDDED_MODE_ACK') return;

  clearTimeout(pendingAck.timeoutId);
  pendingAck.resolve(Boolean(data.enabled));
  pendingAck = null;
}
