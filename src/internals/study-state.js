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
  /* Hash of a study's SETTINGS.

     getInputValues() returns 361 entries on the reference strategy, and 8 of
     them are not settings at all. Measured 2026-09-10 across two full
     recomputes, hashing the whole array produced a DIFFERENT hash every time
     (b6faec59 -> 1eeb640f -> 387a93cf) because first_visible_bar_time and
     last_visible_bar_time track the viewport. A fence built on that would
     report the configuration as drifting whenever the chart scrolled.

     Excluded, all host or view state rather than strategy configuration:
       text                    the encrypted Pine source (199KB; stable, but
                               pineVersion identifies the script far cheaper)
       pineFeatures            engine capability flags
       __chart_bgcolor         theme
       __chart_fgcolor         theme
       __log_level             logging verbosity
       first_visible_bar_time  viewport, moves on every scroll
       last_visible_bar_time   viewport, moves on every bar
       __profile               profiler toggle

     Allowlisted rather than denylisted: a new volatile host field added by a
     TradingView update would silently rejoin a denylist and break the fence,
     whereas it simply stays out of an allowlist. The remaining 353 entries
     hashed to d4aa3b87 before, during and after two recomputes.

     Hash of a study's input VALUES.
     Part of a state fence: after writing inputs, a report is only the report
     you asked for if the inputs it was computed under are the ones you set.
     TradingView's own input read has been observed returning stale values, so
     the hash is taken from the study-api object, which is the side that tracks
     recompute (see paths.js).
     FNV-1a over the stable JSON of the value array. Order is TradingView's own
     and is stable within a session; this is a change detector, not an identity
     that survives a script edit. */
  function __isSettingInput(x) {
    /* [0-9] not a backslash-d class: this string is a template literal, and
       an unknown escape there silently loses its backslash. The intended
       pattern was emitted into the page as /^in_d+$/ and matched 2 of 361
       entries instead of 353. */
    return /^in_[0-9]+$/.test(x.id) || x.id === 'pineId' || x.id === 'pineVersion';
  }
  function __fnv(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }
  /* Per-key digest, and the hash derived FROM it so the two cannot disagree.

     A single hash can only ever say "something moved". The allowlist above will
     go stale the next time TradingView injects a volatile field into the in_N
     range, and a bare hash would report that as configuration drift for the
     rest of the build's life with no way to see why. The digest makes the
     failure self-describing: checkFence diffs two digests and names the keys.

     Read TWICE and compare. A key that differs between two reads taken
     microseconds apart is volatile by construction, not drifting, and it is
     reported as volatile_keys rather than silently poisoning the hash. This
     catches a field on a timer; it does not catch one that moves only on
     scroll or on a new bar, which is what the key diff is for. */
  function __inputsRead(api) {
    var vals = api.getInputValues();
    var kept = [], skipped = 0, pairs = [];
    for (var i = 0; i < vals.length; i++) {
      if (!__isSettingInput(vals[i])) { skipped++; continue; }
      kept.push(vals[i]);
      pairs.push(vals[i].id + ':' + __fnv(JSON.stringify(vals[i].value)));
    }
    return { total: vals.length, kept: kept.length, skipped: skipped,
             pairs: pairs, hash: __fnv(JSON.stringify(kept)) };
  }
  function __inputsHash(api) {
    if (!api || typeof api.getInputValues !== 'function') return null;
    try { return __inputsRead(api).hash; } catch (e) { return null; }
  }
  function __inputsDigest(api) {
    if (!api || typeof api.getInputValues !== 'function') return null;
    var a, b;
    try { a = __inputsRead(api); b = __inputsRead(api); } catch (e) { return null; }
    var volatileKeys = [];
    if (a.pairs.length === b.pairs.length) {
      for (var i = 0; i < a.pairs.length; i++) {
        if (a.pairs[i] !== b.pairs[i]) volatileKeys.push(a.pairs[i].split(':')[0]);
      }
    } else {
      volatileKeys.push('__length:' + a.pairs.length + '->' + b.pairs.length);
    }
    return {
      hash: a.hash,
      stable: a.hash === b.hash,
      volatile_keys: volatileKeys.slice(0, 20),
      total: a.total, kept: a.kept, skipped: a.skipped,
      pairs: a.pairs,
    };
  }
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
export function studyStateJs(entityIdExpr = 'null', { withDigest = false } = {}) {
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
        /* Tagged so readiness.js can refuse a series row. The two status
           enums overlap numerically and mean opposite things. */
        kind: 'study',
        id: id,
        housekeeping: id.indexOf('ESD$TV_') === 0,
        is_visible: (function () { try { return !!api.isVisible(); } catch (e) { return null; } })(),
        title: (function () { try { return api.title(); } catch (e) { return null; } })(),
        /* status().type — a STUDY enum. Named so it cannot be compared to a
           series status by accident. Interpret only via readiness.js. */
        status_type: st ? st.type : null,
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
        report_gen: (window.__tvmcp_gen && window.__tvmcp_gen[id] != null) ? window.__tvmcp_gen[id] : null,
        inputs_hash: __inputsHash(api),
        inputs_digest: ${withDigest ? '__inputsDigest(api)' : 'null'},
        backtest_from: (function () { try { return rd.settings.dateRange.backtest.from; } catch (e) { return null; } })()
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
        kind: 'series',
        is_loading: (function () { try { return !!ms.isLoading(); } catch (e) { return null; } })(),
        bar_count: (function () { try { return ms.bars().size(); } catch (e) { return null; } })(),
        /* Observational only, and deliberately not used by any predicate:
           2 = loading, 3 = ready on THIS object, the reverse of a study, and
           it reads 3 both before a mutation tears the series down and after
           the rebuild completes. See readiness.js. */
        series_status_raw: (function () { try { return ms.status(); } catch (e) { return null; } })(),
        /* Edge counts from dataEvents(). The only signal that separates
           "has not started reloading" from "has finished reloading". Null
           when the counters are not installed. */
        events: (window.__tvmcp_sev && window.__tvmcp_sev.counts)
          ? { loading: window.__tvmcp_sev.counts.loading,
              cleared: window.__tvmcp_sev.counts.cleared,
              completed: window.__tvmcp_sev.counts.completed,
              error: window.__tvmcp_sev.counts.error,
              unsupported: window.__tvmcp_sev.counts.unsupportedResolutionRequested }
          : null,
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

    /* The price series needs the same treatment for the same reason, and it
       is not optional: measured 2026-09-10, every instantaneous series signal
       reads exactly as it does when settled for 139-380ms after a
       mutation, while still holding the previous resolution's bars. Counting
       dataEvents() fires is what closes that window.

       Only edges that mean a rebuild are counted. dataUpdated fires on every
       tick (43 times in 22s on a live 45S chart) and would count as evidence
       of nothing. */
    if (!window.__tvmcp_sev) {
      var ms2 = null; try { ms2 = __chart.model().mainSeries(); } catch (e) {}
      if (ms2) {
        try {
          var de = ms2.dataEvents();
          var sev = { counts: {}, subs: [] };
          var evNames = ['loading', 'cleared', 'completed', 'error',
                         'unsupportedResolutionRequested'];
          for (var e2 = 0; e2 < evNames.length; e2++) {
            (function (n) {
              var d = de[n]();
              var h = function () { sev.counts[n] = (sev.counts[n] || 0) + 1; };
              d.subscribe(null, h);
              sev.subs.push({ d: d, h: h });
              sev.counts[n] = 0;
            })(evNames[e2]);
          }
          window.__tvmcp_sev = sev;
        } catch (e) { /* bus moved; barrier degrades to the weak test */ }
      }
    }

    return {
      installed: bound,
      gen: window.__tvmcp_gen,
      fp: fps,
      events: window.__tvmcp_sev ? window.__tvmcp_sev.counts : null
    };
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
    var seriesRemoved = 0;
    if (window.__tvmcp_sev) {
      var ss = window.__tvmcp_sev.subs || [];
      for (var i = 0; i < ss.length; i++) {
        try { ss[i].d.unsubscribe(null, ss[i].h); seriesRemoved++; } catch (e) {}
      }
      delete window.__tvmcp_sev;
    }
    return { removed: removed, series_events_removed: seriesRemoved };
  })()`;
