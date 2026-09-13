/**
 * Phase 0.7 Task 1, step 2 — replay PILOT. Mechanics only, before the long run.
 *
 * Answers, cheaply:
 *   - what replay serves at start: main bars, study rows, their first times
 *   - whether rows accumulate with stepping or the window slides
 *   - per-step cost split into cursor move vs study row arrival
 *   - whether a row for the new bar exists WITHOUT waiting (decides if the long
 *     run can step fast and dump once, or must wait per bar)
 *
 * Starts replay at T, steps N bars, dumps rows, stops replay and clears the
 * saved session. No orders, no inputs.
 *
 * usage: node recon/j02.mjs <T epoch seconds> <steps> [out]
 */
import { writeFileSync } from 'node:fs';
import { evaluate } from '../src/connection.js';
import { start, stop } from '../src/core/replay.js';

const ENTITY = 'xVbiv5';
const T = Number(process.argv[2]);
const N = Number(process.argv[3] || 30);
const OUT = process.argv[4] || 'recon/j02.json';

const FIND = `
  var cw = window.TradingViewApi._activeChartWidgetWV.value();
  var m = cw._chartWidget.model().model(); var ms = m.mainSeries(); var mb = ms.bars();
  var srcs = m.dataSources(); var s = null;
  for (var i=0;i<srcs.length;i++){ try{ if (srcs[i].id()===${JSON.stringify(ENTITY)}){s=srcs[i];break;} }catch(e){} }
  var rp = window.TradingViewApi._replayApi;
  function u(v){ return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; }
`;

const SHAPE_JS = `(function(){ ${FIND}
  var d = s.data();
  var fr = d.size() ? d.valueAt(d.firstIndex()) : null; var lr = d.size() ? d.valueAt(d.lastIndex()) : null;
  var rd = null; try { rd = s.reportData(); if (rd && typeof rd.value === 'function') rd = rd.value(); } catch(e){}
  return { cursor: u(rp.currentDate()), started: u(rp.isReplayStarted()),
    main_size: mb.size(), main_t0: mb.size() ? mb.valueAt(mb.firstIndex())[0] : null, main_t1: mb.size() ? mb.valueAt(mb.lastIndex())[0] : null,
    rows: d.size(), row_t0: fr && fr[0], row_t1: lr && lr[0],
    status: cw.getStudyById(${JSON.stringify(ENTITY)}).status().type,
    trades: rd && rd.trades ? rd.trades.length : null,
    backtest_from: rd && rd.settings && rd.settings.dateRange && rd.settings.dateRange.backtest && rd.settings.dateRange.backtest.from };
})()`;

// One step, timed in-page: cursor edge, then the study's row for the new last bar.
const STEP_JS = `(async function(){ ${FIND}
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  var before = u(rp.currentDate()); var t0 = Date.now();
  rp.doStep();
  while (u(rp.currentDate()) === before) { if (Date.now() - t0 > 30000) return { stalled: true }; await sleep(5); }
  var cursorMs = Date.now() - t0;
  var lastBar = mb.valueAt(mb.lastIndex())[0];
  var d = s.data();
  var rowAtOnce = !!(d.size() && d.valueAt(d.lastIndex())[0] === lastBar);
  while (true) {
    var lr = d.size() ? d.valueAt(d.lastIndex()) : null;
    var st = cw.getStudyById(${JSON.stringify(ENTITY)}).status().type;
    if (lr && lr[0] === lastBar && st === 2) break;
    if (Date.now() - t0 > 60000) return { cursor_ms: cursorMs, row_timeout: true };
    await sleep(5);
  }
  return { cursor_ms: cursorMs, row_ms: Date.now() - t0, row_present_at_cursor_edge: rowAtOnce,
           last_bar: lastBar, rows: d.size(), main_size: mb.size(), row_t0: d.valueAt(d.firstIndex())[0] };
})()`;

const ROWS_JS = `(function(){ ${FIND}
  var rows = []; s.data().each(function(idx, v){ rows.push(Array.prototype.slice.call(v)); return false; });
  return JSON.stringify(rows);
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { T, N, t_iso: new Date(T * 1000).toISOString() };

try {
  out.pre = await evaluate(SHAPE_JS);
  if (out.pre.started) throw new Error('replay already started; refusing to re-arm on top of it');
  const t0 = Date.now();
  out.start = await start({ date: new Date(T * 1000).toISOString() });
  out.start_ms = Date.now() - t0;
  // shape immediately, then after the study settles
  out.shape_at_start = await evaluate(SHAPE_JS);
  const s0 = Date.now();
  while (Date.now() - s0 < 120000) {
    const sh = await evaluate(SHAPE_JS);
    if (sh.status === 2 && sh.rows > 0) { out.shape_settled = { ...sh, waited_ms: Date.now() - s0 }; break; }
    await sleep(250);
  }
  out.rows_at_start = JSON.parse(await evaluate(ROWS_JS));
  out.steps = [];
  for (let i = 0; i < N; i++) {
    out.steps.push(await evaluate(STEP_JS, { awaitPromise: true }));
    if (out.steps.at(-1).stalled || out.steps.at(-1).row_timeout) break;
  }
  out.shape_end = await evaluate(SHAPE_JS);
  out.rows_end = JSON.parse(await evaluate(ROWS_JS));
} catch (err) {
  out.error = String(err?.stack || err);
} finally {
  try { out.stop = await stop(); } catch (err) { out.stop_error = String(err); }
  try { out.post = await evaluate(SHAPE_JS); } catch {}
}

writeFileSync(OUT, JSON.stringify(out));
const brief = { ...out, rows_at_start: out.rows_at_start?.length, rows_end: out.rows_end?.length, steps: out.steps?.map((s) => [s.cursor_ms, s.row_ms, s.row_present_at_cursor_edge, s.rows, s.main_size, s.row_t0]) };
console.log(JSON.stringify(brief, null, 1));
process.exit(out.error ? 1 : 0);
