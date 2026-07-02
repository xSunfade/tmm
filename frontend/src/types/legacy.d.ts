export {};

declare global {
  interface Window {
    tmmLegacyApi?: {
      restoreSession?: (meta?: unknown) => void;
    };
  }
}
