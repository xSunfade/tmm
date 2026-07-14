import { createContext, useContext } from 'react';

/**
 * Save/backup truth indicator (Phase 2.3, UX-A): one honest, always-visible
 * answer to "is my plan safe?". The two persistence gates in PlanProvider
 * publish their piece; AppLayout renders the combined state.
 */

export type LocalSaveStatus = 'saved' | 'save_failed';

export type ServerSyncStatus =
  /** signed out / restore pending — server sync not running */
  | 'disabled'
  /** initial reconcile with the server is in flight */
  | 'checking'
  /** last push (or hydrate) succeeded; plan is on the server */
  | 'synced'
  /** edits pending or push in flight */
  | 'saving'
  /** backend unreachable — local-only until a later session reconciles */
  | 'offline'
  /** 409: another device saved a newer version; user must choose */
  | 'conflict';

export type ServerSyncState = {
  status: ServerSyncStatus;
  /** client_saved_at of the last known-good server copy, if any */
  savedAt: string | null;
};

export const LocalSaveStatusContext = createContext<LocalSaveStatus>('saved');
export const ServerSyncStatusContext = createContext<ServerSyncState>({
  status: 'disabled',
  savedAt: null
});

export type PlanSaveStatus = {
  local: LocalSaveStatus;
  server: ServerSyncStatus;
  serverSavedAt: string | null;
};

export function usePlanSaveStatus(): PlanSaveStatus {
  const local = useContext(LocalSaveStatusContext);
  const server = useContext(ServerSyncStatusContext);
  return { local, server: server.status, serverSavedAt: server.savedAt };
}
