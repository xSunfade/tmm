import React from 'react';
import { usePlanStore } from '../../lib/plan/planStore';
import type { PipelineEdge } from '../../lib/plan/types';
import { applyFlowsToAlternative, computeNodes, isFlowAllowed } from '../../lib/pipeline/engine';
import { PipelineCanvas } from './PipelineCanvas';
import { FlowDetailsModal } from './FlowDetailsModal';
import { NodePropertiesModal } from './NodePropertiesModal';
import { autoLayout, computeFitTransform, ensureLayout } from './pipelineLayout';

export function PipelineScreen() {
  const { state: planState, dispatch } = usePlanStore();
  const activeAltName = planState.activeAlt;
  const activeAlt = planState.alternatives[activeAltName];
  const pipeline = planState.pipeline.byAlt[activeAltName] || { edges: [], layout: {} };
  const nodes = computeNodes(activeAlt);
  const [zoom, setZoom] = React.useState(1);
  const [pan, setPan] = React.useState({ x: 0, y: 0 });
  const [showAddNode, setShowAddNode] = React.useState(false);
  const [flowModal, setFlowModal] = React.useState<
    | null
    | {
        mode: 'create' | 'edit';
        edgeIndex?: number;
        fromId: string;
        toId: string;
        fromPort: string;
        toPort: string;
      }
  >(null);
  const [nodeModalId, setNodeModalId] = React.useState<string | null>(null);
  const canvasWrapRef = React.useRef<HTMLDivElement | null>(null);
  const autoFitRef = React.useRef(new Set<string>());

  const id2node = React.useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const layoutWithDefaults = React.useMemo(() => ensureLayout(nodes, pipeline.layout || {}), [nodes, pipeline.layout]);

  const sanitizeEdges = (edges: PipelineEdge[]) =>
    edges.filter((edge) => {
      const fromNode = id2node.get(edge.from);
      const toNode = id2node.get(edge.to);
      if (!fromNode || !toNode) return false;
      return isFlowAllowed(fromNode.kind, toNode.kind);
    });

  const updatePipeline = (
    nextEdges: PipelineEdge[],
    nextLayout: Record<string, { x: number; y: number }>,
    applyFlows: boolean
  ) => {
    const cleanEdges = sanitizeEdges(nextEdges);
    const nextPipeline = {
      ...planState.pipeline,
      byAlt: {
        ...planState.pipeline.byAlt,
        [activeAltName]: { ...pipeline, edges: cleanEdges, layout: nextLayout }
      }
    };
    dispatch({ type: 'setPipeline', pipeline: nextPipeline });
    if (applyFlows) {
      const nextAlt = JSON.parse(JSON.stringify(activeAlt));
      applyFlowsToAlternative(nextAlt, nextPipeline.byAlt[activeAltName]);
      dispatch({ type: 'setAlternative', altName: activeAltName, alt: nextAlt });
    }
  };

  const addNode = (kind: 'income' | 'expense' | 'asset' | 'debt') => {
    const nextAlt = JSON.parse(JSON.stringify(activeAlt));
    if (kind === 'income') {
      nextAlt.income.push({ uuid: `income_${Date.now()}`, name: 'New income', amount: 0, freq: 'monthly', start: new Date().toISOString().slice(0, 10), raise: 0 });
    }
    if (kind === 'expense') {
      nextAlt.expense.push({ uuid: `expense_${Date.now()}`, name: 'New expense', amount: 0, freq: 'monthly', start: new Date().toISOString().slice(0, 10), infl: 0, source: '' });
    }
    if (kind === 'asset') {
      nextAlt.asset.push({ uuid: `asset_${Date.now()}`, mode: 'Manual', name: 'New asset', group: '', value: 0, apy: 0, ticker: '', quantity: 0, liveprice: 0, totalContrib: 0, recurAmt: 0, recurFreq: 'monthly', source: '' });
    }
    if (kind === 'debt') {
      nextAlt.debt.push({ uuid: `debt_${Date.now()}`, name: 'New debt', bal: 0, apr: 0, pmt: 0, freq: 'monthly', start: new Date().toISOString().slice(0, 10), source: '' });
    }
    applyFlowsToAlternative(nextAlt, pipeline);
    dispatch({ type: 'setAlternative', altName: activeAltName, alt: nextAlt });
  };

  const openFlowModal = (payload: { fromId: string; toId: string; fromPort: string; toPort: string }) => {
    setFlowModal({ mode: 'create', fromId: payload.fromId, toId: payload.toId, fromPort: payload.fromPort, toPort: payload.toPort });
  };

  const openEditModal = (edgeIndex: number) => {
    const edge = pipeline.edges[edgeIndex];
    if (!edge) return;
    const from = layoutWithDefaults[edge.from];
    const to = layoutWithDefaults[edge.to];
    const fromPort = edge.fromPort || (from && to && from.x < to.x ? 'right' : 'left');
    const toPort = edge.toPort || (from && to && from.x < to.x ? 'left' : 'right');
    setFlowModal({
      mode: 'edit',
      edgeIndex,
      fromId: edge.from,
      toId: edge.to,
      fromPort,
      toPort
    });
  };

  const handleFlowSave = (result: { mode: PipelineEdge['mode']; amount: number; freq: PipelineEdge['freq']; recurFreq?: PipelineEdge['recurFreq'] }) => {
    if (!flowModal) return;
    const nextEdges = [...pipeline.edges];
    if (flowModal.mode === 'edit' && flowModal.edgeIndex !== undefined) {
      nextEdges[flowModal.edgeIndex] = {
        ...nextEdges[flowModal.edgeIndex],
        mode: result.mode,
        amount: result.amount,
        freq: result.freq,
        recurFreq: result.recurFreq,
        fromPort: flowModal.fromPort,
        toPort: flowModal.toPort
      };
    } else {
      nextEdges.push({
        from: flowModal.fromId,
        to: flowModal.toId,
        mode: result.mode,
        amount: result.amount,
        freq: result.freq,
        recurFreq: result.recurFreq,
        fromPort: flowModal.fromPort,
        toPort: flowModal.toPort
      });
    }
    updatePipeline(nextEdges, layoutWithDefaults, true);
    setFlowModal(null);
  };

  const handleFlowDelete = () => {
    if (!flowModal || flowModal.edgeIndex === undefined) return;
    const nextEdges = pipeline.edges.filter((_, index) => index !== flowModal.edgeIndex);
    updatePipeline(nextEdges, layoutWithDefaults, true);
    setFlowModal(null);
  };

  const handleNodeSave = (nextAlt: typeof activeAlt) => {
    const altCopy = JSON.parse(JSON.stringify(nextAlt));
    applyFlowsToAlternative(altCopy, pipeline);
    dispatch({ type: 'setAlternative', altName: activeAltName, alt: altCopy });
    setNodeModalId(null);
  };

  const handleNodeDelete = (nodeId: string) => {
    const [kind, idxStr] = nodeId.split(':');
    const idx = Number(idxStr);
    const nextAlt = JSON.parse(JSON.stringify(activeAlt));
    if (Number.isFinite(idx) && (nextAlt as any)[kind]) {
      (nextAlt as any)[kind].splice(idx, 1);
    }
    const nextEdges = pipeline.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId);
    const nextLayout = { ...pipeline.layout };
    delete nextLayout[nodeId];
    applyFlowsToAlternative(nextAlt, { edges: nextEdges, layout: nextLayout });
    dispatch({ type: 'setAlternative', altName: activeAltName, alt: nextAlt });
    updatePipeline(nextEdges, nextLayout, false);
    setNodeModalId(null);
  };

  const handleAutoLayout = () => {
    const nextLayout = autoLayout(nodes);
    updatePipeline(pipeline.edges, nextLayout, false);
    const wrap = canvasWrapRef.current;
    if (wrap) {
      const rect = wrap.getBoundingClientRect();
      const { zoom: nextZoom, pan: nextPan } = computeFitTransform(nodes, nextLayout, {
        width: rect.width,
        height: rect.height
      });
      setZoom(nextZoom);
      setPan(nextPan);
    }
  };

  const handleFit = () => {
    const wrap = canvasWrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const { zoom: nextZoom, pan: nextPan } = computeFitTransform(nodes, layoutWithDefaults, {
      width: rect.width,
      height: rect.height
    });
    setZoom(nextZoom);
    setPan(nextPan);
  };

  React.useEffect(() => {
    if (!nodes.length) return;
    if (autoFitRef.current.has(activeAltName)) return;
    if (!canvasWrapRef.current) return;
    const rect = canvasWrapRef.current.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const { zoom: nextZoom, pan: nextPan } = computeFitTransform(nodes, layoutWithDefaults, {
      width: rect.width,
      height: rect.height
    });
    autoFitRef.current.add(activeAltName);
    setZoom(nextZoom);
    setPan(nextPan);
  }, [activeAltName, layoutWithDefaults, nodes, setPan, setZoom]);

  return (
    <div className="min-h-screen bg-slate-950 px-6 py-8 text-slate-200">
      <div className="mx-auto w-full max-w-6xl space-y-6">
        <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
          <h1 className="text-2xl font-semibold text-slate-100">Pipeline Builder</h1>
        </div>

        <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-300">
            <span className="text-sm font-semibold text-slate-200">Pipeline Builder</span>
            <label className="flex items-center gap-2">
              Active:
              <select
                className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                value={activeAltName}
                onChange={(event) => dispatch({ type: 'setActiveAlt', altName: event.target.value })}
              >
                {Object.keys(planState.alternatives || {}).map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <span className="rounded-full bg-slate-800 px-2 py-1 text-[10px] text-slate-300">Auto layout</span>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-slate-300">
            <div className="relative">
              <button
                className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200"
                type="button"
                onClick={() => setShowAddNode((prev) => !prev)}
              >
                + NODE
              </button>
              {showAddNode ? (
                <div className="absolute left-0 top-full z-10 mt-2 w-40 rounded-lg border border-slate-700 bg-slate-900 p-2 text-xs text-slate-200 shadow-lg">
                  {(['income', 'asset', 'expense', 'debt'] as const).map((kind) => (
                    <button
                      key={kind}
                      className="block w-full rounded px-2 py-1 text-left hover:bg-slate-800"
                      type="button"
                      onClick={() => {
                        addNode(kind);
                        setShowAddNode(false);
                      }}
                    >
                      {kind}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <button
              className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200"
              type="button"
              onClick={() => {
                window.alert('To create a flow: press on a node port, drag, and release on another port. A Flow Details dialog will open.');
              }}
            >
              How to connect
            </button>
            <button
              className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200"
              type="button"
              onClick={handleAutoLayout}
            >
              Auto-layout
            </button>
            <span className="rounded-full border border-slate-800 px-2 py-1 text-[10px] text-slate-400">
              All changes saved
            </span>
            <div className="ml-auto flex items-center gap-2 text-xs text-slate-400">
              <button
                className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200"
                type="button"
                onClick={() => setZoom((z) => Math.max(0.5, z - 0.1))}
              >
                −
              </button>
              <span>{Math.round(zoom * 100)}%</span>
              <button
                className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200"
                type="button"
                onClick={() => setZoom((z) => Math.min(2.5, z + 0.1))}
              >
                +
              </button>
              <button
                className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200"
                type="button"
                onClick={() => {
                  handleFit();
                }}
              >
                Fit
              </button>
            </div>
          </div>
          <div className="mt-3 text-[11px] text-slate-500">
            Tip: Connect ports by drag-and-drop or click-to-connect. Right-click the canvas to cancel linking. Flows update instantly; % flows draw from the source Income monthly amount.
          </div>
          <div className="mt-4" ref={canvasWrapRef} data-tour="pipeline-canvas">
            <PipelineCanvas
              nodes={nodes}
              edges={pipeline.edges}
              layout={layoutWithDefaults}
              onLayoutChange={(nextLayout) => updatePipeline(pipeline.edges, nextLayout, false)}
              onConnectRequest={openFlowModal}
              onEdgeClick={openEditModal}
              onNodeClick={(nodeId) => setNodeModalId(nodeId)}
              zoom={zoom}
              setZoom={setZoom}
              pan={pan}
              setPan={setPan}
            />
          </div>
          <div className="mt-4 border-t border-slate-800 pt-3">
            <h3 className="text-xs font-semibold text-slate-400">All Flow Details</h3>
            <div className="mt-2 space-y-2 text-xs text-slate-300">
              {pipeline.edges.length === 0 ? (
                <div className="text-slate-500">No flows yet.</div>
              ) : (
                pipeline.edges.map((edge, index) => {
                  const fromName = id2node.get(edge.from)?.name || edge.from;
                  const toName = id2node.get(edge.to)?.name || edge.to;
                  const amountLabel = edge.mode === 'percent' ? `${edge.amount}%` : `$${edge.amount}`;
                  const freqLabel = edge.mode === 'percent' ? 'of monthly income' : edge.freq || 'monthly';
                  const recurLabel =
                    id2node.get(edge.to)?.kind === 'asset' && edge.recurFreq && edge.recurFreq !== 'monthly'
                      ? ` · recur ${edge.recurFreq}`
                      : '';
                  return (
                    <div key={`${edge.from}-${edge.to}-${index}`} className="flex items-center justify-between gap-4">
                      <div className="truncate">
                        {fromName} → {toName}{' '}
                        <span className="text-[11px] text-slate-500">
                          ({amountLabel} · {freqLabel}
                          {recurLabel})
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          className="rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-200"
                          type="button"
                          onClick={() => openEditModal(index)}
                        >
                          Edit
                        </button>
                        <button
                          className="rounded-md border border-rose-500/60 px-2 py-1 text-[11px] text-rose-200"
                          type="button"
                          onClick={() => {
                            const nextEdges = pipeline.edges.filter((_, idx) => idx !== index);
                            updatePipeline(nextEdges, layoutWithDefaults, true);
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
          <div className="mt-2 text-xs text-slate-500">
            Flow types: $ fixed (choose frequency) and % of source. Targets: Assets → recurring contribution, Debts → extra principal, Expenses → monthly amount.
          </div>
        </section>
      </div>
      <FlowDetailsModal
        open={Boolean(flowModal)}
        defaults={
          flowModal?.mode === 'edit' && flowModal.edgeIndex !== undefined
            ? {
                amount:
                  pipeline.edges[flowModal.edgeIndex]?.mode === 'percent'
                    ? `${pipeline.edges[flowModal.edgeIndex]?.amount}%`
                    : String(pipeline.edges[flowModal.edgeIndex]?.amount ?? ''),
                freq: pipeline.edges[flowModal.edgeIndex]?.freq || 'monthly',
                recurFreq: pipeline.edges[flowModal.edgeIndex]?.recurFreq || 'monthly'
              }
            : { amount: '', freq: 'monthly', recurFreq: 'monthly' }
        }
        isAssetFlow={flowModal ? id2node.get(flowModal.toId)?.kind === 'asset' : false}
        onCancel={() => setFlowModal(null)}
        onSave={handleFlowSave}
        onDelete={flowModal?.mode === 'edit' ? handleFlowDelete : undefined}
      />
      <NodePropertiesModal
        open={Boolean(nodeModalId)}
        nodeId={nodeModalId}
        alt={activeAlt}
        onClose={() => setNodeModalId(null)}
        onSave={handleNodeSave}
        onDelete={handleNodeDelete}
      />
    </div>
  );
}
