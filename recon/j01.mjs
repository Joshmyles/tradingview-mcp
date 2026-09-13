/**
 * Phase 0.7 Task 1, step 1 — capture the WARM reference, and prove it is stable.
 *
 * The normal chart's strategy is computed server-side over ~21.8k bars while the
 * client holds only ~500 plot rows. So the right-edge rows are warm, but only a
 * window of them is visible. This script:
 *
 *   1. snapshots every B15 plot row + the trade list as loaded now        (A)
 *   2. extends loaded history with requestMoreData (same as scrolling)
 *   3. waits for the study to settle, snapshots again                       (B)
 *   4. diffs A against B over their overlap
 *
 * If extending history changes rows that were already loaded, the reference
 * itself depends on load depth, and Experiment A cannot use it as ground truth.
 * That check runs before anything else relies on the reference.
 *
 * Read-only apart from loading more history. No replay, no inputs, no orders.
 */
import { writeFileSync } from 'node:fs';
import { evaluate } from '../src/connection.js';

const ENTITY = process.argv[2] || 'xVbiv5';
const BARS_BACK = Number(process.argv[3] || 7000);

const dumpJs = (tag) => `
(function(){
  var cw = window.TradingViewApi._activeChartWidgetWV.value();
  var m = cw._chartWidget.model().model(); var ms = m.mainSeries(); var mb = ms.bars();
  var srcs = m.dataSources(); var s = null;
  for (var i=0;i<srcs.length;i++){ try{ if (srcs[i].id()===${JSON.stringify(ENTITY)}){s=srcs[i];break;} }catch(e){} }
  if (!s) return JSON.stringify({ error: 'study not found' });
  var rows = [];
  s.data().each(function(idx, v){ rows.push(Array.prototype.slice.call(v)); return false; });
  var bars = [];
  mb.each(function(idx, v){ bars.push([v[0], v[1], v[2], v[3], v[4]]); return false; });
  var rd = s.reportData(); if (rd && typeof rd.value === 'function') rd = rd.value();
  var mi = s.metaInfo();
  return JSON.stringify({
    tag: ${JSON.stringify(tag)}, read_at: Date.now(),
    status: cw.getStudyById(${JSON.stringify(ENTITY)}).status(),
    plots: (mi.plots||[]).map(function(p){ var st = mi.styles && mi.styles[p.id]; return { id: p.id, type: p.type, title: st && st.title || null }; }),
    rows: rows, bars: bars,
    trades: rd ? (rd.trades||[]).map(function(t){ return { e: t.e, x: t.x, q: t.q, pf: t.pf }; }) : null,
    date_range: rd && rd.settings && rd.settings.dateRange,
    net: rd && rd.performance && rd.performance.all && rd.performance.all.netProfit
  });
})()`;

const snapshot = async (tag) => JSON.parse(await evaluate(dumpJs(tag)));

// Wait until the study reports settled AND its row count has held still, so a
// half-recomputed window is not taken as the reference.
async function waitSettled(label, { quietMs = 4000, timeoutMs = 180000 } = {}) {
  const t0 = Date.now();
  let lastSize = -1; let stableSince = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await evaluate(`(function(){
      var cw = window.TradingViewApi._activeChartWidgetWV.value();
      var m = cw._chartWidget.model().model(); var srcs = m.dataSources(); var s=null;
      for (var i=0;i<srcs.length;i++){ try{ if (srcs[i].id()===${JSON.stringify(ENTITY)}){s=srcs[i];break;} }catch(e){} }
      return { size: s.data().size(), bars: m.mainSeries().bars().size(), loading: m.mainSeries().isLoading(),
               status: cw.getStudyById(${JSON.stringify(ENTITY)}).status().type };
    })()`);
    if (r.size !== lastSize) { lastSize = r.size; stableSince = Date.now(); }
    if (!r.loading && r.status === 2 && Date.now() - stableSince >= quietMs) {
      return { ...r, waited_ms: Date.now() - t0 };
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error(`${label}: study did not settle within ${timeoutMs}ms`);
}

const EQ = (a, b) => {
  if (a === b) return true;
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
};

function diffOverlap(A, B) {
  const byT = new Map(B.rows.map((r) => [r[0], r]));
  let overlap = 0; const changedRows = []; const perPlot = {};
  for (const ra of A.rows) {
    const rb = byT.get(ra[0]); if (!rb) continue;
    overlap++;
    const cols = [];
    for (let c = 1; c < Math.max(ra.length, rb.length); c++) {
      if (!EQ(ra[c], rb[c])) { cols.push(c - 1); perPlot[c - 1] = (perPlot[c - 1] || 0) + 1; }
    }
    if (cols.length) changedRows.push({ t: ra[0], plots: cols });
  }
  const tradeKey = (t) => `${t.e.tm}|${t.e.c}|${t.e.p}|${t.x.tm}|${t.x.p}`;
  const inA = new Set((A.trades || []).map(tradeKey));
  const inB = new Set((B.trades || []).map(tradeKey));
  return {
    overlap_rows: overlap,
    rows_changed: changedRows.length,
    per_plot_changed: perPlot,
    first_changed: changedRows.slice(0, 5),
    trades_only_in_A: [...inA].filter((k) => !inB.has(k)),
    trades_only_in_B: [...inB].filter((k) => !inA.has(k)).length,
  };
}

const out = { entity: ENTITY, bars_back: BARS_BACK };
out.settle_A = await waitSettled('A');
const A = await snapshot('A');
out.A = { rows: A.rows.length, bars: A.bars.length, t_first: A.rows[0]?.[0], t_last: A.rows.at(-1)?.[0],
  trades: A.trades?.length, date_range: A.date_range, net: A.net };

const target = A.bars.at(-1)[0] - BARS_BACK * 45;
const { ensureHistoryJs } = await import('../src/internals/equity.js');
out.extend = await evaluate(ensureHistoryJs(target, 5000, 6), { awaitPromise: true });
out.settle_B = await waitSettled('B');
const B = await snapshot('B');
out.B = { rows: B.rows.length, bars: B.bars.length, t_first: B.rows[0]?.[0], t_last: B.rows.at(-1)?.[0],
  trades: B.trades?.length, date_range: B.date_range, net: B.net };
out.stability = diffOverlap(A, B);

writeFileSync('recon/j01-ref.json', JSON.stringify(B));
writeFileSync('recon/j01.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, (k, v) => (k === 'log' ? undefined : v), 2));
process.exit(0);
