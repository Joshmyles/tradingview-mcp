/**
 * Phase 0.7 Task 1 — one replay session: start at T, step to E, dump everything.
 *
 * Used for Experiment A (T inside the warm reference, compare to j01-ref.json)
 * and Experiment B (two sessions from different T to the same E, compare to
 * each other).
 *
 * Stepping is FAST: the in-page loop waits on the cursor edge only, not on the
 * study, because the pilot measured the row for a new bar arriving ~15s late on
 * two steps in three. The run then waits for the study to catch up before it
 * dumps. Whether fast stepping changes what the study computes is checked by
 * comparing an A run's first bars against the pilot's waited-per-bar rows.
 *
 * usage: node recon/j03.mjs <T sec> <E sec> <out.json>
 */
import { writeFileSync } from 'node:fs';
import { evaluate } from '../src/connection.js';
import { start, stop } from '../src/core/replay.js';
import { stepUntilJs, summariseSteps } from '../src/internals/replay.js';

const ENTITY = 'xVbiv5';
const [T, E] = [Number(process.argv[2]), Number(process.argv[3])];
const OUT = process.argv[4];
if (!(T > 0 && E > T && OUT)) { console.error('usage: j03.mjs <T sec> <E sec> <out.json>'); process.exit(2); }

const FIND = `
  var cw = window.TradingViewApi._activeChartWidgetWV.value();
  var m = cw._chartWidget.model().model(); var ms = m.mainSeries(); var mb = ms.bars();
  var srcs = m.dataSources(); var s = null;
  for (var i=0;i<srcs.length;i++){ try{ if (srcs[i].id()===${JSON.stringify(ENTITY)}){s=srcs[i];break;} }catch(e){} }
  var rp = window.TradingViewApi._replayApi;
  function u(v){ return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; }
`;

const SHAPE_JS = `(function(){ ${FIND}
  var d = s.data(); var lr = d.size() ? d.valueAt(d.lastIndex()) : null;
  var rd = null; try { rd = s.reportData(); if (rd && typeof rd.value === 'function') rd = rd.value(); } catch(e){}
  return { cursor: u(rp.currentDate()), started: u(rp.isReplayStarted()),
    main_size: mb.size(), main_t1: mb.size() ? mb.valueAt(mb.lastIndex())[0] : null,
    rows: d.size(), row_t0: d.size() ? d.valueAt(d.firstIndex())[0] : null, row_t1: lr && lr[0],
    status: cw.getStudyById(${JSON.stringify(ENTITY)}).status().type,
    trades: rd && rd.trades ? rd.trades.length : null, filled: rd && rd.filledOrders ? rd.filledOrders.length : null,
    backtest_from: rd && rd.settings && rd.settings.dateRange && rd.settings.dateRange.backtest && rd.settings.dateRange.backtest.from };
})()`;

const DUMP_JS = `(function(){ ${FIND}
  var rows = []; s.data().each(function(idx, v){ rows.push(Array.prototype.slice.call(v)); return false; });
  var bars = []; mb.each(function(idx, v){ bars.push([v[0], v[1], v[2], v[3], v[4]]); return false; });
  var rd = s.reportData(); if (rd && typeof rd.value === 'function') rd = rd.value();
  var mi = s.metaInfo();
  return JSON.stringify({
    plots: (mi.plots||[]).map(function(p){ var st = mi.styles && mi.styles[p.id]; return { id: p.id, type: p.type, title: st && st.title || null }; }),
    rows: rows, bars: bars,
    trades: rd ? (rd.trades||[]).map(function(t){ return { e: t.e, x: t.x, q: t.q, pf: t.pf }; }) : null,
    open_position: rd && rd.position, date_range: rd && rd.settings && rd.settings.dateRange,
    net: rd && rd.performance && rd.performance.all && rd.performance.all.netProfit,
    filled_orders: rd && rd.filledOrders ? rd.filledOrders.length : null });
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Settled = study idle, its last row is the last bar, and row + trade counts held still. */
async function waitCaughtUp(label, { quietMs = 8000, timeoutMs = 600000 } = {}) {
  const t0 = Date.now(); let sig = ''; let since = Date.now(); let sh;
  while (Date.now() - t0 < timeoutMs) {
    sh = await evaluate(SHAPE_JS);
    const s = `${sh.rows}|${sh.trades}|${sh.filled}|${sh.row_t1}`;
    if (s !== sig) { sig = s; since = Date.now(); }
    if (sh.status === 2 && sh.rows > 0 && sh.row_t1 === sh.main_t1 && Date.now() - since >= quietMs) {
      return { ...sh, waited_ms: Date.now() - t0 };
    }
    await sleep(500);
  }
  throw new Error(`${label}: study did not catch up within ${timeoutMs}ms; last shape ${JSON.stringify(sh)}`);
}

const out = { T, E, T_iso: new Date(T * 1000).toISOString(), E_iso: new Date(E * 1000).toISOString(), entity: ENTITY };
let exitCode = 0;
try {
  const pre = await evaluate(SHAPE_JS);
  if (pre.started) throw new Error('replay already started; refusing to arm on top of it');
  const t0 = Date.now();
  out.start = await start({ date: new Date(T * 1000).toISOString() });
  out.settled_at_start = await waitCaughtUp('start');
  out.start_dump = JSON.parse(await evaluate(DUMP_JS));

  const run = await evaluate(stepUntilJs({
    entityId: ENTITY, combinator: 'all', clauses: [{ field: 'time', op: 'gte', value: E * 1000 }],
    maxBars: 100000, stepTimeoutMs: 30000, deadlineMs: 4 * 3600 * 1000, settleEachStep: false, settleTimeoutMs: 0,
  }), { awaitPromise: true });
  out.run = { ok: run.ok, stopped_on: run.stopped_on, bars_advanced: run.bars_advanced, elapsed_ms: run.elapsed_ms,
    end_time: run.state?.time, step_latency: summariseSteps(run.step_ms) };
  if (run.stopped_on !== 'predicate') throw new Error(`stepping stopped on ${run.stopped_on}, not the target bar`);

  out.settled_at_end = await waitCaughtUp('end');
  out.end_dump = JSON.parse(await evaluate(DUMP_JS));
  out.total_wall_ms = Date.now() - t0;
} catch (err) {
  out.error = String(err?.stack || err); exitCode = 1;
} finally {
  try { out.stop = await stop(); } catch (err) { out.stop_error = String(err); }
}

writeFileSync(OUT, JSON.stringify(out));
const brief = (d) => d && { rows: d.rows.length, row_t0: d.rows[0]?.[0], row_t1: d.rows.at(-1)?.[0], trades: d.trades?.length, net: d.net, date_range: d.date_range };
console.log(JSON.stringify({ ...out, start_dump: brief(out.start_dump), end_dump: brief(out.end_dump) }, null, 1));
process.exit(exitCode);
