/**
 * Page-context JS for reading study readiness and strategy report state.
 *
 * INTERNAL — see paths.js. Re-verify after every TradingView update.
 *
 * Everything here is emitted as a string and evaluated inside the TradingView
 * page. Keep it ES5: it runs in the page, not in Node, and it must not depend
 * on anything the page does not already have.
 */
import { PATHS } from './paths.js';

/**
 * Shared helpers installed into the evaluated scope by every snippet below.
 *
 * Why two objects per study: the study-api object (getStudyById) tracks
 * recompute; the data source carries the strategy report. Measured
 * 2026-09-10, they disagree — the data source claimed ready while the
 * study-api object was still loading with dataLength 0. See paths.js.
 */
export const HELPERS_JS = `
  var __cw = ${PATHS.chartApi};
  var __chart = __cw._chartWidget;
  function __sources() { return __chart.model().model().dataSources(); }
  function __sourceId(s) { try { return s.id ? s.id() : null; } catch (e) { return null; } }
  function __isStrategySource(s) {
    if (typeof s.reportData !== 'function') return false;
    try { var mi = s.metaInfo ? s.metaInfo() : null;
          if (mi && (mi.isTVScriptStrategy || mi.is_strategy)) return true; } catch (e) {}
    return true;
  }
  function __report(s) {
    try { var r = s.reportData(); if (r && typeof r.value === 'function') r = r.value(); return r || null; }
    catch (e) { return null; }
  }
  function __api(id) { try { return __cw.getStudyById(id); } catch (e) { return null; } }
  /* Fingerprint of a report's IDENTITY, not its liveness.
     backtest.to drifts with every new bar on a live chart (measured: +30s
     ticks on a 30S chart), so it is deliberately excluded — including it
     would make a settled report look permanently unstable. */
  function __fingerprint(rd) {
    if (!rd) return null;
    var n = rd.trades ? rd.trades.length : -1;
    var np = (rd.performance && rd.performance.all) ? rd.performance.all.netProfit : null;
    var from = null;
    try { from = rd.settings.dateRange.backtest.from; } catch (e) {}
    var lastExit = null;
    try { var t = rd.trades[n - 1]; lastExit = t && t.x ? t.x.tm : null; } catch (e) {}
    return [n, np, from, lastExit, (rd.filledOrders ? rd.filledOrders.length : -1)].join('|');
  }
`;

/**
 * Snapshot every study on the chart, or just one.
 *
 * Returns { resolution, symbol, studies: [{ id, title, type, is_loading,
 * data_length, has_error, loading_since_ms, is_strategy, report_present,
 * report_fingerprint, report_gen }] }.
 */
export function studyStateJs(entityIdExpr = 'null') {
  return `
  (function() {
    ${HELPERS_JS}
    var want = ${entityIdExpr};
    var srcs = __sources();
    var out = [];
    var now = Date.now();
    for (var i = 0; i < srcs.length; i++) {
      var s = srcs[i];
      var id = __sourceId(s);
      if (!id) continue;
      var api = __api(id);
      if (!api) continue;
      if (want && id !== want) continue;
      var st = null; try { st = api.status(); } catch (e) {}
      var isStrat = __isStrategySource(s);
      var rd = isStrat ? __report(s) : null;
      out.push({
        id: id,
        housekeeping: id.indexOf('ESD$TV_') === 0,
        is_visible: (function () { try { return !!api.isVisible(); } catch (e) { return null; } })(),
        title: (function () { try { return api.title(); } catch (e) { return null; } })(),
        type: st ? st.type : null,
        is_loading: (function () { try { return !!api.isLoading(); } catch (e) { return null; } })(),
        data_length: (function () { try { return api.dataLength(); } catch (e) { return null; } })(),
        has_error: (function () { try { return !!api.hasError(); } catch (e) { return null; } })(),
        /* status().errorDescription is where the reason lives — errorMessage()
           returned null in the one observed failure while this carried
           { error: 'resolve error', title: 'Runtime error' }. */
        error_description: (st && st.errorDescription)
          ? { error: st.errorDescription.error || null, title: st.errorDescription.title || null }
          : null,
        loading_since_ms: (st && st.startTime) ? (now - st.startTime) : null,
        is_strategy: isStrat,
        report_present: !!rd,
        report_fingerprint: __fingerprint(rd),
        report_gen: (window.__tvmcp_gen && window.__tvmcp_gen[id] != null) ? window.__tvmcp_gen[id] : null
      });
    }
    /* The price series, which the loop above cannot reach: it lives in
       dataSources() as '_seriesId' but getStudyById throws on that id, so every
       source-enumerating snapshot skips it silently. Its readiness vocabulary is
       its own — see paths.js. */
    var ms = null; try { ms = __chart.model().mainSeries(); } catch (e) {}
    var series = null;
    if (ms) {
      series = {
        is_loading: (function () { try { return !!ms.isLoading(); } catch (e) { return null; } })(),
        bar_count: (function () { try { return ms.bars().size(); } catch (e) { return null; } })(),
        /* Observational only. This is NOT the study status enum. */
        status_raw: (function () { try { return ms.status(); } catch (e) { return null; } })(),
        error: (function () { try { var v = ms.seriesErrorMessage(); return (v && v.value) ? v.value() : (v || null); } catch (e) { return null; } })(),
        unsupported_resolution: (function () { try { var v = ms.unsupportedResolutionState(); return (v && v.value) ? v.value() : (v || null); } catch (e) { return null; } })(),
        symbol: (function () { try { var si = ms.symbolInfo(); return si ? (si.full_name || si.name) : null; } catch (e) { return null; } })()
      };
    }
    return {
      resolution: (function () { try { return __chart.model().mainSeries().properties().interval.value(); } catch (e) { return null; } })(),
      symbol: (function () { try { return __cw.symbol(); } catch (e) { return null; } })(),
      series: series,
      studies: out
    };
  })()`;
}

/**
 * Install a persistent report-generation counter.
 *
 * reportChanged() is a Delegate with subscribe/unsubscribe. Every time
 * TradingView replaces a strategy's report it fires. Counting fires gives a
 * true generation number, which is the only reliable way to tell "the report
 * I am reading was regenerated for the state I just set" from "the report I
 * am reading is the previous window's, still sitting there".
 *
 * Measured 2026-09-10, sampling at 50ms across a 45S->30S change: the chart's
 * resolution had already flipped to 30S while reportData still returned the
 * PREVIOUS book (105 trades, net 177.21, window from 1787695320000). The report
 * then went null, and the new book (68 trades, net -94.63, window from
 * 1788213720000) did not appear until 19.2s after the mutation.
 *
 * The overlap is short when the mutation is issued directly (~0.3s) and runs to
 * ~7.5s when issued through a tool that does its own waiting first — either way
 * a caller reading in that window gets a complete, plausible, wrong answer with
 * no error at all.
 *
 * Idempotent: re-installing rebinds without double-counting.
 */
export const INSTALL_GEN_COUNTER_JS = `
  (function() {
    ${HELPERS_JS}
    if (!window.__tvmcp_gen) window.__tvmcp_gen = {};
    if (!window.__tvmcp_gen_subs) window.__tvmcp_gen_subs = {};
    var srcs = __sources();
    var bound = [];
    for (var i = 0; i < srcs.length; i++) {
      var s = srcs[i];
      if (!__isStrategySource(s)) continue;
      var id = __sourceId(s);
      if (!id || typeof s.reportChanged !== 'function') continue;
      if (window.__tvmcp_gen_subs[id]) { bound.push(id); continue; }
      (function (sid, src) {
        var d = src.reportChanged();
        var h = function () { window.__tvmcp_gen[sid] = (window.__tvmcp_gen[sid] || 0) + 1; };
        d.subscribe(null, h);
        window.__tvmcp_gen_subs[sid] = { d: d, h: h };
        if (window.__tvmcp_gen[sid] == null) window.__tvmcp_gen[sid] = 0;
      })(id, s);
      bound.push(id);
    }
    /* Fingerprints are captured alongside the counter because the counter
       alone is not sufficient evidence of a regeneration. Measured 2026-09-10:
       reportChanged() fired three times (gen 179 -> 182) while the report's
       content stayed byte-identical. A caller requiring only a gen bump
       can therefore be satisfied by a no-op refire that left the PREVIOUS
       book in place. Comparing fingerprints catches that; the counter does not. */
    var fps = {};
    for (var k = 0; k < srcs.length; k++) {
      var s2 = srcs[k];
      if (!__isStrategySource(s2)) continue;
      var id2 = __sourceId(s2);
      if (!id2) continue;
      fps[id2] = __fingerprint(__report(s2));
    }
    return { installed: bound, gen: window.__tvmcp_gen, fp: fps };
  })()`;

/** Remove the generation counters. Used by tests and on CDP reconnect. */
export const UNINSTALL_GEN_COUNTER_JS = `
  (function() {
    var subs = window.__tvmcp_gen_subs || {};
    var removed = [];
    for (var id in subs) {
      try { subs[id].d.unsubscribe(null, subs[id].h); removed.push(id); } catch (e) {}
    }
    delete window.__tvmcp_gen_subs;
    delete window.__tvmcp_gen;
    return { removed: removed };
  })()`;
