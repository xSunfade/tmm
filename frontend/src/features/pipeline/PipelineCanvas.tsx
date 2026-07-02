import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PipelineEdge } from '../../lib/plan/types';
import type { PipelineNode } from '../../lib/pipeline/engine';
import { isFlowAllowed } from '../../lib/pipeline/engine';
import { ensureLayout } from './pipelineLayout';

type PipelineCanvasProps = {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  layout: Record<string, { x: number; y: number }>;
  onLayoutChange: (layout: Record<string, { x: number; y: number }>) => void;
  onConnectRequest: (payload: { fromId: string; toId: string; fromPort: string; toPort: string }) => void;
  onEdgeClick: (edgeIndex: number) => void;
  onNodeClick: (nodeId: string) => void;
  zoom: number;
  setZoom: (zoom: number) => void;
  pan: { x: number; y: number };
  setPan: (pan: { x: number; y: number }) => void;
};

export function PipelineCanvas({
  nodes,
  edges,
  layout,
  onLayoutChange,
  onConnectRequest,
  onEdgeClick,
  onNodeClick,
  zoom,
  setZoom,
  pan,
  setPan
}: PipelineCanvasProps) {
  const [pendingFrom, setPendingFrom] = useState<{ id: string; port: string } | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const dragRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
    moved: boolean;
  } | null>(null);
  const nodeRefs = useRef(new Map<string, HTMLDivElement>());
  const [dragFlow, setDragFlow] = useState<{
    fromId: string;
    fromPort: string;
    fromKind: PipelineNode['kind'];
    sx: number;
    sy: number;
    mx: number;
    my: number;
  } | null>(null);

  React.useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const cursorX = (event.clientX - rect.left) / zoom - pan.x;
      const cursorY = (event.clientY - rect.top) / zoom - pan.y;
      const direction = event.deltaY > 0 ? -1 : 1;
      const nextZoom = Math.min(2.5, Math.max(0.5, zoom + direction * 0.1));
      const scale = nextZoom / zoom;
      setPan({
        x: pan.x - cursorX * (scale - 1),
        y: pan.y - cursorY * (scale - 1)
      });
      setZoom(nextZoom);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [pan.x, pan.y, setPan, setZoom, zoom]);

  useLayoutEffect(() => {
    if (!canvasRef.current) return;
    const element = canvasRef.current;
    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      setCanvasSize({ width: rect.width, height: rect.height });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const computedLayout = useMemo(() => ensureLayout(nodes, layout), [layout, nodes]);
  const id2node = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  const getNodeSize = (id: string) => {
    const el = nodeRefs.current.get(id);
    const size = {
      width: el?.offsetWidth ?? 176,
      height: el?.offsetHeight ?? 120
    };
    return size;
  };

  const getPortPosition = (id: string, port: string) => {
    const pos = computedLayout[id] || { x: 0, y: 0 };
    const { width, height } = getNodeSize(id);
    if (port === 'left') return { x: pos.x, y: pos.y + height / 2 };
    if (port === 'right') return { x: pos.x + width, y: pos.y + height / 2 };
    if (port === 'top') return { x: pos.x + width / 2, y: pos.y };
    return { x: pos.x + width / 2, y: pos.y + height };
  };

  const toCanvasCoords = React.useCallback(
    (clientX: number, clientY: number) => {
      if (!canvasRef.current) return { x: 0, y: 0 };
      const rect = canvasRef.current.getBoundingClientRect();
      return {
        x: (clientX - rect.left) / zoom - pan.x,
        y: (clientY - rect.top) / zoom - pan.y
      };
    },
    [pan.x, pan.y, zoom]
  );

  const handleContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    setPendingFrom(null);
  };

  const makeEdgePath = (x1: number, y1: number, x2: number, y2: number) => {
    const dx = Math.max(60, Math.abs(x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  };
  const startNodeDrag = (event: React.MouseEvent, id: string) => {
    event.stopPropagation();
    if (!canvasRef.current) return;
    const pos = computedLayout[id] || { x: 0, y: 0 };
    dragRef.current = {
      id,
      startX: event.clientX,
      startY: event.clientY,
      baseX: pos.x,
      baseY: pos.y,
      moved: false
    };
    const onMove = (moveEvent: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = (moveEvent.clientX - dragRef.current.startX) / zoom;
      const dy = (moveEvent.clientY - dragRef.current.startY) / zoom;
      if (!dragRef.current.moved) {
        const movedDistance = Math.abs(moveEvent.clientX - dragRef.current.startX) + Math.abs(moveEvent.clientY - dragRef.current.startY);
        if (movedDistance > 4) dragRef.current.moved = true;
      }
      const nextLayout = {
        ...computedLayout,
        [id]: { x: dragRef.current.baseX + dx, y: dragRef.current.baseY + dy }
      };
      onLayoutChange(nextLayout);
    };
    const onUp = () => {
      const moved = dragRef.current?.moved;
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (!moved) {
        onNodeClick(id);
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handlePortClick = (event: React.MouseEvent, nodeId: string, port: string) => {
    event.stopPropagation();
    if (dragFlow) return;
    if (!pendingFrom) {
      setPendingFrom({ id: nodeId, port });
      return;
    }
    if (pendingFrom.id === nodeId) {
      setPendingFrom(null);
      return;
    }
    const fromKind = pendingFrom.id.split(':')[0] as PipelineNode['kind'];
    const toKind = nodeId.split(':')[0] as PipelineNode['kind'];
    if (!isFlowAllowed(fromKind, toKind)) {
      setPendingFrom(null);
      return;
    }
    onConnectRequest({ fromId: pendingFrom.id, toId: nodeId, fromPort: pendingFrom.port, toPort: port });
    setPendingFrom(null);
  };

  const startPortDrag = (event: React.MouseEvent, nodeId: string, port: string) => {
    event.stopPropagation();
    const node = id2node.get(nodeId);
    if (!node) return;
    const { x, y } = getPortPosition(nodeId, port);
    const point = toCanvasCoords(event.clientX, event.clientY);
    setDragFlow({
      fromId: nodeId,
      fromPort: port,
      fromKind: node.kind,
      sx: x,
      sy: y,
      mx: point.x,
      my: point.y
    });
  };

  React.useEffect(() => {
    if (!dragFlow) return;
    const onMove = (event: MouseEvent) => {
      const point = toCanvasCoords(event.clientX, event.clientY);
      setDragFlow((prev) => (prev ? { ...prev, mx: point.x, my: point.y } : prev));
    };
    const onUp = (event: MouseEvent) => {
      const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      const portEl = target?.closest('.pipeline-port') as HTMLElement | null;
      if (portEl) {
        const toId = portEl.dataset.nodeId;
        const toPort = portEl.dataset.port;
        if (toId && toPort && toId !== dragFlow.fromId) {
          const fromKind = dragFlow.fromId.split(':')[0] as PipelineNode['kind'];
          const toKind = toId.split(':')[0] as PipelineNode['kind'];
          if (isFlowAllowed(fromKind, toKind)) {
            onConnectRequest({ fromId: dragFlow.fromId, toId, fromPort: dragFlow.fromPort, toPort });
          }
        }
      }
      setDragFlow(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragFlow, onConnectRequest, toCanvasCoords]);

  const startPan = (event: React.MouseEvent) => {
    if (!canvasRef.current) return;
    if ((event.target as HTMLElement).closest('.pipeline-node')) return;
    if ((event.target as HTMLElement).closest('.pipeline-port')) return;
    const start = { x: event.clientX, y: event.clientY };
    const startPan = { ...pan };
    const onMove = (moveEvent: MouseEvent) => {
      setPan({
        x: startPan.x + (moveEvent.clientX - start.x) / zoom,
        y: startPan.y + (moveEvent.clientY - start.y) / zoom
      });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleNodeMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const width = Math.max(rect.width, 1);
    const height = Math.max(rect.height, 1);
    const normalizedX = (event.clientX - rect.left) / width;
    const normalizedY = (event.clientY - rect.top) / height;
    const centeredX = normalizedX - 0.5;
    const centeredY = normalizedY - 0.5;
    const maxTiltDeg = 8.5;
    const tiltX = -centeredY * maxTiltDeg;
    const tiltY = centeredX * maxTiltDeg;
    event.currentTarget.style.setProperty('--pipeline-tilt-x', `${tiltX.toFixed(2)}deg`);
    event.currentTarget.style.setProperty('--pipeline-tilt-y', `${tiltY.toFixed(2)}deg`);
    event.currentTarget.style.setProperty('--pipeline-tilt-z', '2px');
  };

  const handleNodeMouseLeave = (event: React.MouseEvent<HTMLDivElement>) => {
    event.currentTarget.style.setProperty('--pipeline-tilt-x', '0deg');
    event.currentTarget.style.setProperty('--pipeline-tilt-y', '0deg');
    event.currentTarget.style.setProperty('--pipeline-tilt-z', '0px');
  };

  return (
    <div
      ref={canvasRef}
      className="relative h-[520px] overflow-hidden rounded-lg border border-slate-800 bg-slate-950"
      onMouseDown={startPan}
      onContextMenu={handleContextMenu}
    >
      <div
        className="absolute inset-0"
        style={{ transform: `scale(${zoom}) translate(${pan.x}px, ${pan.y}px)`, transformOrigin: '0 0' }}
      >
        <svg
          className="absolute inset-0 h-full w-full overflow-visible"
          width={canvasSize.width}
          height={canvasSize.height}
          viewBox={`0 0 ${canvasSize.width} ${canvasSize.height}`}
          preserveAspectRatio="none"
        >
          {edges.map((edge, index) => {
            const from = computedLayout[edge.from];
            const to = computedLayout[edge.to];
            if (!from || !to) return null;
            const fromPort = edge.fromPort || (from.x < to.x ? 'right' : 'left');
            const toPort = edge.toPort || (from.x < to.x ? 'left' : 'right');
            const fromPos = getPortPosition(edge.from, fromPort);
            const toPos = getPortPosition(edge.to, toPort);
            const path = makeEdgePath(fromPos.x, fromPos.y, toPos.x, toPos.y);
            const toKind = id2node.get(edge.to)?.kind;
            const edgeClass =
              toKind === 'asset'
                ? 'pipeline-edge pipeline-edge--asset'
                : toKind === 'expense'
                ? 'pipeline-edge pipeline-edge--expense'
                : toKind === 'debt'
                ? 'pipeline-edge pipeline-edge--debt'
                : 'pipeline-edge';
            return (
              <g key={`${edge.from}-${edge.to}-${index}`}>
                <path className={edgeClass} d={path} />
                <path className="pipeline-edge-hit" d={path} onClick={() => onEdgeClick(index)} />
              </g>
            );
          })}
          {dragFlow ? (
            <path
              className="pipeline-edge pipeline-edge--temp"
              d={makeEdgePath(dragFlow.sx, dragFlow.sy, dragFlow.mx, dragFlow.my)}
            />
          ) : null}
        </svg>
        {nodes.map((node) => {
          const pos = computedLayout[node.id];
          const linkingClass =
            node.kind === 'expense'
              ? 'pipeline-linking pipeline-linking--expense'
              : node.kind === 'debt'
              ? 'pipeline-linking pipeline-linking--debt'
              : node.kind === 'asset'
              ? 'pipeline-linking pipeline-linking--asset'
              : 'pipeline-linking pipeline-linking--income';
          return (
            <div
              key={node.id}
              ref={(el) => {
                if (el) nodeRefs.current.set(node.id, el);
              }}
              className={`pipeline-node absolute w-44 cursor-move rounded-lg border border-slate-700 bg-slate-900/90 p-3 text-xs text-slate-200 shadow-lg ${node.isConnected ? 'pipeline-node--connected' : ''}`}
              style={{ left: pos?.x ?? 0, top: pos?.y ?? 0 }}
              onMouseDown={(event) => startNodeDrag(event, node.id)}
              onMouseMove={handleNodeMouseMove}
              onMouseLeave={handleNodeMouseLeave}
            >
              <div className="flex items-center justify-between text-[10px] uppercase text-slate-400">
                <span>{node.kind}</span>
                {pendingFrom?.id === node.id ? <span className={linkingClass}>LINKING</span> : null}
              </div>
              <div className="text-sm text-slate-100">{node.name}</div>
              <div className="text-xs text-slate-400">{node.displayValue}</div>
              <div className="pipeline-ports">
                {(['left', 'right', 'top', 'bottom'] as const).map((port) => (
                  <button
                    key={port}
                    className={`pipeline-port pipeline-port--${port} ${
                      pendingFrom?.id === node.id && pendingFrom.port === port ? 'pipeline-port--active' : ''
                    }`}
                    type="button"
                    data-node-id={node.id}
                    data-port={port}
                    onMouseDown={(event) => startPortDrag(event, node.id, port)}
                    onClick={(event) => handlePortClick(event, node.id, port)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
