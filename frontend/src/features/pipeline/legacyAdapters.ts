import {
  getScopedLocalStorageItem,
  setScopedLocalStorageItem
} from '../../lib/storage/userScopedStorage';

export type PipelineNode = {
  id: string;
  label: string;
};

export type PipelineEdge = {
  id: string;
  from: string;
  to: string;
};

export type PipelineState = {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
};

const STORAGE_KEY = 'tmm_pipeline_state';

function readStorage(): PipelineState {
  if (typeof window === 'undefined') {
    return { nodes: [], edges: [] };
  }
  const raw = getScopedLocalStorageItem(STORAGE_KEY);
  if (!raw) return { nodes: [], edges: [] };
  try {
    return JSON.parse(raw) as PipelineState;
  } catch (error) {
    console.warn('[pipeline] Failed to parse pipeline state', error);
    return { nodes: [], edges: [] };
  }
}

function writeStorage(state: PipelineState) {
  if (typeof window === 'undefined') return;
  setScopedLocalStorageItem(STORAGE_KEY, JSON.stringify(state));
}

export function loadPipeline(): PipelineState {
  return readStorage();
}

export function savePipeline(state: PipelineState) {
  writeStorage(state);
}
