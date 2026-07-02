import type { PipelineNode } from '../../lib/pipeline/engine';

type LayoutMap = Record<string, { x: number; y: number }>;

export const defaultPositions: Record<PipelineNode['kind'], { x: number; y: number }> = {
  income: { x: 40, y: 80 },
  asset: { x: 360, y: 80 },
  debt: { x: 360, y: 260 },
  expense: { x: 680, y: 80 }
};

export function ensureLayout(nodes: PipelineNode[], layout: LayoutMap): LayoutMap {
  const next: LayoutMap = { ...layout };
  const count: Record<string, number> = { income: 0, asset: 0, debt: 0, expense: 0 };
  nodes.forEach((node) => {
    if (!next[node.id]) {
      const base = defaultPositions[node.kind];
      const offset = count[node.kind] * 140;
      next[node.id] = { x: base.x, y: base.y + offset };
      count[node.kind] += 1;
    }
  });
  return next;
}

export function autoLayout(nodes: PipelineNode[]): LayoutMap {
  const next: LayoutMap = {};
  const cols: Record<PipelineNode['kind'], PipelineNode[]> = {
    income: [],
    asset: [],
    debt: [],
    expense: []
  };
  nodes.forEach((node) => cols[node.kind].push(node));
  const xCol: Record<PipelineNode['kind'], number> = {
    income: 80,
    asset: 560,
    debt: 560,
    expense: 900
  };
  (Object.keys(cols) as Array<PipelineNode['kind']>).forEach((kind) => {
    cols[kind].forEach((node, idx) => {
      next[node.id] = { x: xCol[kind], y: 100 + idx * 140 };
    });
  });
  return next;
}

export function computeFitTransform(
  nodes: PipelineNode[],
  layout: LayoutMap,
  viewport: { width: number; height: number },
  options?: { padding?: number; nodeWidth?: number; nodeHeight?: number; minZoom?: number; maxZoom?: number }
): { zoom: number; pan: { x: number; y: number } } {
  if (!nodes.length || viewport.width <= 0 || viewport.height <= 0) {
    return { zoom: 1, pan: { x: 0, y: 0 } };
  }
  const padding = options?.padding ?? 40;
  const nodeWidth = options?.nodeWidth ?? 176;
  const nodeHeight = options?.nodeHeight ?? 120;
  const minZoom = options?.minZoom ?? 0.5;
  const maxZoom = options?.maxZoom ?? 2.5;
  const ensured = ensureLayout(nodes, layout);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  nodes.forEach((node) => {
    const pos = ensured[node.id] || { x: 0, y: 0 };
    minX = Math.min(minX, pos.x);
    minY = Math.min(minY, pos.y);
    maxX = Math.max(maxX, pos.x + nodeWidth);
    maxY = Math.max(maxY, pos.y + nodeHeight);
  });

  minX -= padding;
  minY -= padding;
  maxX += padding;
  maxY += padding;

  const contentWidth = maxX - minX;
  const contentHeight = maxY - minY;
  const zoomX = viewport.width / contentWidth;
  const zoomY = viewport.height / contentHeight;
  const fitZoom = Math.min(zoomX, zoomY, maxZoom);
  const zoom = Math.max(minZoom, fitZoom);

  const scaledWidth = contentWidth * zoom;
  const scaledHeight = contentHeight * zoom;
  const panX = (viewport.width - scaledWidth) / (2 * zoom) - minX;
  const panY = (viewport.height - scaledHeight) / (2 * zoom) - minY;

  return { zoom, pan: { x: panX, y: panY } };
}
