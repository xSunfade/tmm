import type { Alternative, Frequency, PipelineEdge, PipelineState } from '../plan/types';
import { FPM } from '../plan/frequency';
import { getEffectiveValue } from '../plan/overrideManager';

export type PipelineNode = {
  id: string;
  idx: number;
  kind: 'income' | 'expense' | 'asset' | 'debt';
  name: string;
  displayValue: string;
  sub: string;
  isConnected?: boolean;
};

export function isFlowAllowed(fromKind: PipelineNode['kind'], toKind: PipelineNode['kind']) {
  const map: Record<PipelineNode['kind'], Set<PipelineNode['kind']>> = {
    income: new Set(['income', 'asset', 'expense', 'debt']),
    expense: new Set(['expense', 'debt']),
    asset: new Set(['asset', 'expense', 'debt']),
    debt: new Set(['debt'])
  };
  return map[fromKind].has(toKind);
}

function fmt(value: number) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

type PipelineNodeRaw = {
  id: string;
  idx: number;
  kind: PipelineNode['kind'];
  name: string;
  monthly?: number;
  amount?: number;
  freq?: string;
  start?: string;
  raise?: number;
  infl?: number;
  source?: string;
  value?: number;
  recurAmt?: number;
  recurFreq?: string;
  apy?: number;
  pmt?: number;
  balance?: number;
  mode?: string;
  group?: string;
  ticker?: string;
  isConnected?: boolean;
};

function computeNodesRaw(alt: Alternative): PipelineNodeRaw[] {
  const nodes: PipelineNodeRaw[] = [];
  alt.income.forEach((r, i) => {
    const amount = getEffectiveValue(r) || 0;
    const monthly = amount * (FPM[r.freq || 'monthly'] || 1);
    nodes.push({
      id: `income:${i}`,
      idx: i,
      kind: 'income',
      name: r.name || `Income ${i + 1}`,
      monthly,
      amount,
      freq: r.freq,
      start: r.start,
      raise: r.raise,
      isConnected: r.dataSource === 'connected' && Boolean(r.connectedAccountId)
    });
  });
  alt.expense.forEach((r, i) => {
    const amount = getEffectiveValue(r) || 0;
    const monthly = amount * (FPM[r.freq || 'monthly'] || 1);
    nodes.push({
      id: `expense:${i}`,
      idx: i,
      kind: 'expense',
      name: r.name || `Expense ${i + 1}`,
      monthly,
      amount,
      freq: r.freq,
      start: r.start,
      infl: r.infl,
      source: r.source,
      isConnected: r.dataSource === 'connected' && Boolean(r.connectedAccountId)
    });
  });
  alt.asset.forEach((r, i) => {
    const value = getEffectiveValue(r) || 0;
    nodes.push({
      id: `asset:${i}`,
      idx: i,
      kind: 'asset',
      name: r.name || r.ticker || `Asset ${i + 1}`,
      value,
      recurAmt: r.recurAmt,
      recurFreq: r.recurFreq,
      mode: r.mode,
      group: r.group,
      ticker: r.ticker,
      source: r.source,
      isConnected: r.dataSource === 'connected' && Boolean(r.connectedAccountId)
    });
  });
  alt.debt.forEach((r, i) => {
    const balance = getEffectiveValue(r) || 0;
    nodes.push({
      id: `debt:${i}`,
      idx: i,
      kind: 'debt',
      name: r.name || `Debt ${i + 1}`,
      balance,
      apy: r.apr,
      pmt: r.pmt,
      freq: r.freq,
      start: r.start,
      source: r.source,
      isConnected: r.dataSource === 'connected' && Boolean(r.connectedAccountId)
    });
  });
  return nodes;
}

export function computeNodes(alt: Alternative): PipelineNode[] {
  const raw = computeNodesRaw(alt);
  return raw.map((node) => {
    if (node.kind === 'income' || node.kind === 'expense') {
      const subParts: string[] = [];
      if (node.kind === 'income' && node.raise) subParts.push(`${node.raise}% raise/yr`);
      if (node.kind === 'expense' && node.infl) subParts.push(`${node.infl}% infl/yr`);
      if (node.start) subParts.push(`Start: ${node.start}`);
      return {
        id: node.id,
        idx: node.idx,
        kind: node.kind,
        name: node.name,
        displayValue: fmt(node.monthly || 0),
        sub: subParts.length ? subParts.join(' • ') : 'per month',
        isConnected: node.isConnected
      };
    }
    if (node.kind === 'asset') {
      const subParts: string[] = [];
      if (node.recurAmt && node.recurAmt > 0) subParts.push(`+${fmt(node.recurAmt)}/${node.recurFreq || 'mo'}`);
      if (node.mode === 'Ticker' && node.ticker) subParts.push(node.ticker);
      if (node.group) subParts.push(`Group: ${node.group}`);
      return {
        id: node.id,
        idx: node.idx,
        kind: node.kind,
        name: node.name,
        displayValue: fmt(node.value || 0),
        sub: subParts.join(' • '),
        isConnected: node.isConnected
      };
    }
    if (node.kind === 'debt') {
      const subParts: string[] = [];
      if (node.apy) subParts.push(`${node.apy}% APR`);
      if (node.pmt) subParts.push(`$${fmt(node.pmt)}/${node.freq || 'mo'}`);
      return {
        id: node.id,
        idx: node.idx,
        kind: node.kind,
        name: node.name,
        displayValue: fmt(node.balance || 0),
        sub: subParts.join(' • ') || 'balance',
        isConnected: node.isConnected
      };
    }
    return {
      id: node.id,
      idx: node.idx,
      kind: node.kind,
      name: node.name,
      displayValue: fmt(0),
      sub: '',
      isConnected: node.isConnected
    };
  });
}

export function applyFlowsToAlternative(
  alt: Alternative,
  pipeline: PipelineState['byAlt'][string]
) {
  const assetIn = new Map<number, number>();
  const debtIn = new Map<number, number>();
  const expIn = new Map<number, number>();
  const assetSourceMap = new Map<number, string>();
  const expenseSourceMap = new Map<number, string>();
  const debtSourceMap = new Map<number, string>();
  const debtFreqMap = new Map<number, string>();
  const debtAmountMap = new Map<number, number>();
  const assetRecurFreqMap = new Map<number, string>();
  const nodes = computeNodesRaw(alt);
  const id2node = Object.fromEntries(nodes.map((n) => [n.id, n]));

  (pipeline.edges || []).forEach((edge: PipelineEdge) => {
    const from = id2node[edge.from];
    const to = id2node[edge.to];
    if (!from || !to) return;
    if (!isFlowAllowed(from.kind, to.kind)) return;
    let monthlyAmt = 0;
    if (edge.mode === 'percent') {
      if (from.kind !== 'income') return;
      const base = from.monthly || 0;
      monthlyAmt = base * ((edge.amount || 0) / 100);
    } else {
      monthlyAmt = (edge.amount || 0) * (FPM[edge.freq || 'monthly'] || 1);
    }
    if (to.kind === 'asset') {
      assetIn.set(to.idx, (assetIn.get(to.idx) || 0) + monthlyAmt);
      if (from.kind === 'income' && from.name) {
        assetSourceMap.set(to.idx, from.name);
      }
      if (edge.recurFreq) {
        assetRecurFreqMap.set(to.idx, edge.recurFreq);
      }
    } else if (to.kind === 'debt') {
      debtIn.set(to.idx, (debtIn.get(to.idx) || 0) + monthlyAmt);
      if (from.kind === 'income' && from.name) {
        debtSourceMap.set(to.idx, from.name);
      }
      debtFreqMap.set(to.idx, edge.freq || 'monthly');
      debtAmountMap.set(to.idx, edge.amount || 0);
    } else if (to.kind === 'expense') {
      expIn.set(to.idx, (expIn.get(to.idx) || 0) + monthlyAmt);
      if (from.kind === 'income' && from.name) {
        expenseSourceMap.set(to.idx, from.name);
      }
    }
  });

  alt.asset.forEach((row, i) => {
    if (assetIn.has(i) && (assetIn.get(i) || 0) > 0) {
      row.recurAmt = assetIn.get(i) || 0;
      row.recurFreq = (assetRecurFreqMap.get(i) || 'monthly') as Frequency;
      if (assetSourceMap.has(i)) {
        row.source = assetSourceMap.get(i);
      }
    }
  });
  alt.debt.forEach((row, i) => {
    if (debtIn.has(i)) {
      const flowAmount = debtAmountMap.has(i) ? debtAmountMap.get(i) || 0 : debtIn.get(i) || 0;
      row.extraPmt = debtIn.get(i) || 0;
      row.extraFreq = 'monthly' as Frequency;
      if (!row.pmt || row.pmt === 0) {
        row.pmt = flowAmount;
      }
      row.freq = (debtFreqMap.get(i) as any) || row.freq || 'monthly';
      if (!row.start) {
        row.start = new Date().toISOString().slice(0, 10);
      }
    }
    if (debtSourceMap.has(i)) {
      row.source = debtSourceMap.get(i);
    }
  });
  alt.expense.forEach((row, i) => {
    if (expIn.has(i)) {
      row.amount = expIn.get(i) || 0;
      row.freq = 'monthly';
    }
    if (expenseSourceMap.has(i)) {
      row.source = expenseSourceMap.get(i);
    }
  });
}

