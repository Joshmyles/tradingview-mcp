/**
 * Core data access logic.
 */
import {
  evaluate,
  evaluateAsync,
  KNOWN_PATHS,
  safeString,
} from '../connection.js';
import { waitForChartReady } from '../wait.js';
import { readStrategyReport } from '../strategy-report.js';
import { fromReaderFailure } from '../tools/_format.js';
import { captureReportState, requireSettled } from '../settle.js';

const MAX_OHLCV_BARS = 500;
const MAX_TRADES = 20;

// Round to 8 dp — enough to kill float noise (29899.999999997 → 29900) without
// destroying precision on forex/crypto prices. The old 2-dp rounding flattened
// sub-cent levels to 0.00 (issue #77).
const roundPrice = (v) => (v == null ? null : Math.round(v * 1e8) / 1e8);
const CHART_API = KNOWN_PATHS.chartApi;
const BARS_PATH = KNOWN_PATHS.mainSeriesBars;

// Serializes getQuote() calls that mutate chart symbol so concurrent callers
// can't race over the shared chart state. JS is single-threaded but our
// awaits interleave; without this every parallel quote_get(symbol) would
// read whichever symbol the chart happened to be on at evaluate() time.
let _quoteLock = Promise.resolve();

// Shared page-context JS: locate the strategy data source. Strategies are
// identified by metaInfo().isTVScriptStrategy / is_strategy — NOT by
// is_price_study===false (that was the #48/#173/#181 bug: strategies actually
// have is_price_study===true, so the old check excluded every one). Falls
// back to any source exposing reportData/ordersData.
const FIND_STRATEGY_JS = `
  function _reportOf(s) {
    try { var rd = s.reportData(); if (rd && typeof rd.value === 'function') rd = rd.value(); return rd; } catch (e) { return null; }
  }
  function findStrategies() {
    var chart = ${CHART_API}._chartWidget;
    var sources = chart.model().model().dataSources();
    var strategies = [];
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i], mi = null;
      try { mi = s.metaInfo ? s.metaInfo() : null; } catch (e) {}
      var isStrat = mi && (mi.isTVScriptStrategy || mi.is_strategy);
      if ((isStrat || typeof s.reportData === 'function') && typeof s.reportData === 'function') {
        strategies.push({ s: s, name: mi ? mi.description : null });
      }
    }
    return strategies;
  }
  // Returns { strat, report } — prefers a strategy whose report is actually
  // computed (the one selected in the Strategy Tester panel). With multiple
  // strategies on the chart, only the selected one has non-null reportData,
  // so returning the first strategy blindly reads the wrong (empty) one.
  function findStrategy() {
    var strategies = findStrategies();
    // Prefer one with a computed report (has .performance).
    for (var j = 0; j < strategies.length; j++) {
      var rd = _reportOf(strategies[j].s);
      if (rd && rd.performance) return { strat: strategies[j].s, report: rd, name: strategies[j].name, strategy_count: strategies.length };
    }
    // None computed — return the first so callers can hint "open the panel".
    if (strategies.length) return { strat: strategies[0].s, report: null, name: strategies[0].name, strategy_count: strategies.length };
    return null;
  }
  // TradingView never computes a report for a hidden strategy (crossed-out eye
  // in the legend), so a hidden one looks identical to "panel not opened yet".
  // Unhide any hidden strategies and report their names so callers can tell
  // the user what changed.
  function unhideStrategies() {
    var unhidden = [];
    var strategies = findStrategies();
    for (var i = 0; i < strategies.length; i++) {
      var s = strategies[i].s;
      try {
        var vis = null;
        try { vis = s.properties().visible.value(); } catch (e) {}
        if (vis !== false) continue;
        var done = false;
        try { s.properties().visible.setValue(true); done = true; } catch (e) {}
        if (!done) {
          try { var st = ${CHART_API}.getStudyById(s.id()); if (st) { st.setVisible(true); done = true; } } catch (e) {}
        }
        if (done) unhidden.push(strategies[i].name || 'strategy');
      } catch (e) {}
    }
    return unhidden;
  }
`;

/**
 * Gate for reads of computed data.
 *
 * Reads settle; mutations do not. A mutation that returns early is harmless —
 * nothing has been asserted about it. A read that returns early is a wrong
 * answer wearing the costume of a right one, which is the failure this whole
 * layer exists to prevent.
 *
 * `wait: false` is an explicit escape for the caller who genuinely wants
 * whatever is on screen right now; it marks the result rather than hiding it.
 *
 * Cost note: this is not a fixed tax. It is however long the recompute actually
 * takes — on a settled chart it returns in a single poll (measured ~10ms), and
 * on a six-module strategy at 45S after a timeframe change it is ~20s because
 * that is how long TradingView takes.
 */
const settleNote = (gate) =>
  gate.unsettled_by_request
    ? { settled: false, note: gate.note }
    : { settled: true, settle_ms: gate.settle.elapsed_ms };

async function gateRead({ wait = true, series = false, timeoutMs } = {}) {
  if (wait === false) {
    return {
      ok: true,
      unsettled_by_request: true,
      note: 'wait=false: returned without waiting for the chart to settle. If the chart was mid-recompute, this describes the previous state.',
    };
  }
  const gate = await requireSettled({
    scope: 'all',
    requireSeries: series,
    ...(timeoutMs && { timeoutMs }),
  });
  return gate;
}

function buildGraphicsJS(collectionName, mapKey, filter) {
  return `
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var model = chart.model();
      var sources = model.model().dataSources();
      var results = [];
      var filter = ${safeString(filter || '')};
      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;
          if (filter && name.indexOf(filter) === -1) continue;
          var g = s._graphics;
          if (!g || !g._primitivesCollection) continue;
          var pc = g._primitivesCollection;
          var items = [];
          try {
            var outer = pc.${collectionName};
            if (outer) {
              var inner = outer.get('${mapKey}');
              if (inner) {
                var coll = inner.get(false);
                if (coll && coll._primitivesDataById && coll._primitivesDataById.size > 0) {
                  coll._primitivesDataById.forEach(function(v, id) { items.push({id: id, raw: v}); });
                }
              }
            }
          } catch(e) {}
          if (items.length === 0 && '${collectionName}' === 'dwgtablecells') {
            try {
              var tcOuter = pc.dwgtablecells;
              if (tcOuter) {
                var tcColl = tcOuter.get('tableCells');
                if (tcColl && tcColl._primitivesDataById && tcColl._primitivesDataById.size > 0) {
                  tcColl._primitivesDataById.forEach(function(v, id) { items.push({id: id, raw: v}); });
                }
              }
            } catch(e) {}
          }
          if (items.length > 0) results.push({name: name, count: items.length, items: items});
        } catch(e) {}
      }
      return results;
    })()
  `;
}

export async function getOhlcv({ count, summary, wait } = {}) {
  const limit = Math.min(count || 100, MAX_OHLCV_BARS);
  // Bars are the one read that must gate on the price series: the study scopes
  // cannot see it (getStudyById throws on '_seriesId' — see internals/paths.js).
  const gate = await gateRead({ wait, series: true });
  if (!gate.ok) return gate;
  let data;
  try {
    data = await evaluate(`
      (function() {
        var bars = ${BARS_PATH};
        if (!bars || typeof bars.lastIndex !== 'function') return null;
        var result = [];
        var end = bars.lastIndex();
        var start = Math.max(bars.firstIndex(), end - ${limit} + 1);
        for (var i = start; i <= end; i++) {
          var v = bars.valueAt(i);
          if (v) result.push({time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0});
        }
        return {bars: result, total_bars: bars.size(), source: 'direct_bars'};
      })()
    `);
  } catch {
    data = null;
  }

  if (!data || !data.bars || data.bars.length === 0) {
    throw new Error(
      'Could not extract OHLCV data. The chart may still be loading.',
    );
  }

  const provenance = gate.unsettled_by_request
    ? { settled: false, unsettled_by_request: true, note: gate.note }
    : { settled: true, settle_ms: gate.settle.elapsed_ms };

  if (summary) {
    const bars = data.bars;
    const highs = bars.map((b) => b.high);
    const lows = bars.map((b) => b.low);
    const volumes = bars.map((b) => b.volume);
    const first = bars[0];
    const last = bars[bars.length - 1];
    return {
      success: true,
      bar_count: bars.length,
      period: { from: first.time, to: last.time },
      open: first.open,
      close: last.close,
      high: Math.max(...highs),
      low: Math.min(...lows),
      range: roundPrice(Math.max(...highs) - Math.min(...lows)),
      change: roundPrice(last.close - first.open),
      change_pct:
        Math.round(((last.close - first.open) / first.open) * 10000) / 100 +
        '%',
      avg_volume: Math.round(
        volumes.reduce((a, b) => a + b, 0) / volumes.length,
      ),
      last_5_bars: bars.slice(-5),
      provenance,
    };
  }

  return {
    success: true,
    bar_count: data.bars.length,
    total_available: data.total_bars,
    source: data.source,
    bars: data.bars,
    provenance,
  };
}

export async function getIndicator({ entity_id }) {
  const data = await evaluate(`
    (function() {
      var api = ${CHART_API};
      var study = api.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      var result = { name: null, inputs: null, visible: null };
      try { result.visible = study.isVisible(); } catch(e) {}
      try { result.inputs = study.getInputValues(); } catch(e) { result.inputs_error = e.message; }
      return result;
    })()
  `);

  if (data?.error) throw new Error(data.error);

  let inputs = data?.inputs;
  if (Array.isArray(inputs)) {
    inputs = inputs.filter((inp) => {
      if (
        inp.id === 'text' &&
        typeof inp.value === 'string' &&
        inp.value.length > 200
      )
        return false;
      if (typeof inp.value === 'string' && inp.value.length > 500) return false;
      return true;
    });
  }
  return { success: true, entity_id, visible: data?.visible, inputs };
}

// TradingView will not compute a strategy report at all until the Strategy
// Tester panel has been opened, and never computes one for a HIDDEN strategy
// (crossed-out eye in the legend) — a hidden strategy is indistinguishable from
// "panel never opened". Both are preconditions for a report EXISTING.
//
// They are not a substitute for waiting for it to be CURRENT. The 6s poll that
// used to live here accepted the first report with a non-null `performance`,
// which after any chart mutation is the previous window's book — measured
// 2026-09-10, a complete and plausible stale book survives a resolution change
// by 0.3s to 7.5s with no error of any kind. Waiting is now awaitSettled's job
// (src/settle.js). This function only makes a report possible; it never decides
// that one is ready.
//
// One shot, no polling. Returns { unhidden, since } — `since` is captured
// BEFORE the unhide, because unhiding triggers a recompute and the gate must be
// able to tell the resulting report apart from the one that was already there.
async function ensureReportPossible() {
  const since = await captureReportState();
  const unhidden = await evaluate(`
    (function() {
      ${FIND_STRATEGY_JS}
      try {
        var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
        if (bwb && typeof bwb.showWidget === 'function') bwb.showWidget('backtesting');
      } catch (e) {}
      return unhideStrategies();
    })()
  `);
  return {
    unhidden: unhidden || [],
    // Only meaningful as a regeneration baseline if something actually changed.
    // A bare read has no mutation to prove happened, so passing `since` there
    // would demand a teardown that is never coming.
    since: unhidden && unhidden.length ? since : null,
  };
}

/**
 * Shared failure envelope for the three strategy readers.
 *
 * These tools used to return a stale book as `success: true`. They now fail
 * loudly instead, carrying the settle outcome so the caller can tell "still
 * computing" from "will never compute".
 */
function reportFailure(r, extra = {}) {
  return fromReaderFailure(
    {
      ok: false,
      reason: r.reason,
      error: r.error,
      ...(r.settle && {
        settle: {
          outcome: r.settle.outcome,
          elapsed_ms: r.settle.elapsed_ms,
          ...(r.settle.errored_studies && { errored_studies: r.settle.errored_studies }),
          ...(r.settle.pending_studies && { pending_studies: r.settle.pending_studies }),
          ...(r.settle.stuck_studies && { stuck_studies: r.settle.stuck_studies }),
        },
      }),
    },
    { source: 'internal_api', ...extra },
  );
}

const unhiddenNote = (unhidden, what) =>
  unhidden.length
    ? {
        unhidden_strategies: unhidden,
        note: `Strategy was hidden on the chart; it was made visible so ${what} could compute.`,
      }
    : {};

export async function getStrategyResults() {
  const { unhidden, since } = await ensureReportPossible();
  const r = await readStrategyReport({ since });
  if (!r.ok)
    return reportFailure(r, {
      metric_count: 0,
      metrics: {},
      ...unhiddenNote(unhidden, 'the report'),
    });

  const p = r.performance;
  // Legacy key names preserved deliberately: this is a correctness patch, not a
  // contract change. The envelope is reshaped in a later stage, not here.
  const metrics = {
    net_profit: p.net_profit,
    net_profit_percent: p.net_profit_pct,
    gross_profit: p.gross_profit,
    gross_loss: p.gross_loss,
    profit_factor: p.profit_factor,
    max_drawdown: p.max_drawdown,
    max_drawdown_percent: p.max_drawdown_pct,
    total_trades: p.total_trades,
    winning_trades: p.winning_trades,
    losing_trades: p.losing_trades,
    percent_profitable: p.percent_profitable,
    avg_trade: p.avg_trade,
    largest_win: p.largest_win,
    largest_loss: p.largest_loss,
    commission_paid: p.commission_paid,
    sharpe_ratio: p.sharpe_ratio,
    sortino_ratio: p.sortino_ratio,
    buy_hold_return: p.buy_hold_return,
    open_pl: p.open_pl,
  };
  const clean = {};
  for (const k of Object.keys(metrics))
    if (metrics[k] !== null && metrics[k] !== undefined) clean[k] = metrics[k];

  return {
    success: Object.keys(clean).length > 0,
    metric_count: Object.keys(clean).length,
    strategy: r.title,
    entity_id: r.entity_id,
    currency: p.currency,
    source: 'internal_api',
    metrics: clean,
    // Provenance of the numbers above: which report they came from, how long
    // the barrier held, and whether the arithmetic still reconciles.
    provenance: {
      report_gen: r.report_gen,
      settle_ms: r.settle_ms,
      window: r.window,
      reconciliation: r.reconciliation,
      ...(r.read_consistency?.unstable && { unstable: true }),
    },
    ...unhiddenNote(unhidden, 'the report'),
  };
}

export async function getTrades({ max_trades } = {}) {
  const limit = Math.min(max_trades || 20, MAX_TRADES);
  const { unhidden, since } = await ensureReportPossible();
  const r = await readStrategyReport({ since, includeOrders: true });
  if (!r.ok)
    return reportFailure(r, {
      trade_count: 0,
      total_orders: 0,
      trades: [],
      ...unhiddenNote(unhidden, 'orders'),
    });

  // Verified 2026-09-10: ordersData() and reportData().filledOrders are the
  // same array object, so this returns exactly what the old direct read did.
  const all = r.orders || [];
  const tail = all.slice(Math.max(0, all.length - limit));
  return {
    success: tail.length > 0,
    trade_count: tail.length,
    total_orders: all.length,
    source: 'internal_api',
    trades: tail.map((o) => ({
      id: o.id,
      type: o.order_type,
      side: o.side,
      entry: o.is_entry,
      price: o.price,
      qty: o.qty,
      time_index: o.bar_seq,
      // The order tag was being dropped. It is the metadata channel — feature
      // vectors encoded at entry come back here — so it is carried now.
      tag: o.tag,
    })),
    provenance: {
      report_gen: r.report_gen,
      settle_ms: r.settle_ms,
      window: r.window,
      reconciliation: r.reconciliation,
    },
    ...unhiddenNote(unhidden, 'orders'),
  };
}

export async function getEquity() {
  const { unhidden, since } = await ensureReportPossible();
  const r = await readStrategyReport({ since, includeEquity: true });
  if (!r.ok)
    return reportFailure(r, {
      data_points: 0,
      data: [],
      ...unhiddenNote(unhidden, 'the equity curve'),
    });

  // `reportData.equity` and `.equityChart` do not exist and never did — verified
  // absent 2026-09-10. The old code read for them first and always fell through
  // to a note, so this tool has never returned a curve. What does exist is the
  // running cumulative P&L on each trade row, which is a real per-trade curve.
  const eq = r.equity || { points: [] };
  return {
    success: eq.points.length > 0,
    data_points: eq.points.length,
    source: 'internal_api',
    basis: eq.basis,
    per_bar_available: eq.per_bar_available,
    data: eq.points,
    note: 'Per closed trade, not per bar. TradingView does not expose a per-bar account curve through reportData; buy_hold on each point is its aligned baseline (based at 100).',
    provenance: {
      report_gen: r.report_gen,
      settle_ms: r.settle_ms,
      window: r.window,
    },
    ...unhiddenNote(unhidden, 'the equity curve'),
  };
}

export async function getQuote({ symbol } = {}) {
  // Serialize: chained on _quoteLock so parallel callers run one after another.
  // Catch on the lock chain prevents a single failure from poisoning the chain.
  const run = _quoteLock.then(() => _getQuoteInternal({ symbol }));
  _quoteLock = run.then(
    () => {},
    () => {},
  );
  return run;
}

async function _getQuoteInternal({ symbol } = {}) {
  const requested = (symbol || '').toString().trim();
  let originalSymbol = null;
  let needsRestore = false;

  if (requested) {
    try {
      originalSymbol = await evaluate(`${CHART_API}.symbol()`);
    } catch (e) {}
    const bare = (s) => (s || '').toString().split(':').pop().toUpperCase();
    if (bare(originalSymbol) !== bare(requested)) {
      needsRestore = true;
      await evaluateAsync(`
        (function() {
          var chart = ${CHART_API};
          return new Promise(function(resolve) {
            chart.setSymbol(${safeString(requested)}, {});
            setTimeout(resolve, 500);
          });
        })()
      `);
      await waitForChartReady(requested);
    }
  }

  try {
    const gate = await requireSettled({ scope: 'all', requireSeries: true });
    if (!gate.ok) return gate;
    const data = await evaluate(`
      (function() {
        var api = ${CHART_API};
        var sym = '';
        try { sym = api.symbol(); } catch(e) {}
        if (!sym) { try { sym = api.symbolExt().symbol; } catch(e) {} }
        var ext = {};
        try { ext = api.symbolExt() || {}; } catch(e) {}
        var bars = ${BARS_PATH};
        var quote = { symbol: sym };
        if (bars && typeof bars.lastIndex === 'function') {
          var last = bars.valueAt(bars.lastIndex());
          if (last) { quote.time = last[0]; quote.open = last[1]; quote.high = last[2]; quote.low = last[3]; quote.close = last[4]; quote.last = last[4]; quote.volume = last[5] || 0; }
        }
        try {
          var bidEl = document.querySelector('[class*="bid"] [class*="price"], [class*="dom-"] [class*="bid"]');
          var askEl = document.querySelector('[class*="ask"] [class*="price"], [class*="dom-"] [class*="ask"]');
          if (bidEl) quote.bid = parseFloat(bidEl.textContent.replace(/[^0-9.\\-]/g, ''));
          if (askEl) quote.ask = parseFloat(askEl.textContent.replace(/[^0-9.\\-]/g, ''));
        } catch(e) {}
        try {
          var hdr = document.querySelector('[class*="headerRow"] [class*="last-"]');
          if (hdr) { var hdrPrice = parseFloat(hdr.textContent.replace(/[^0-9.\\-]/g, '')); if (!isNaN(hdrPrice)) quote.header_price = hdrPrice; }
        } catch(e) {}
        if (ext.description) quote.description = ext.description;
        if (ext.exchange) quote.exchange = ext.exchange;
        if (ext.type) quote.type = ext.type;
        return quote;
      })()
    `);
    if (!data || (!data.last && !data.close))
      throw new Error(
        'Could not retrieve quote. The chart may still be loading.',
      );
    return { success: true, ...data };
  } finally {
    if (needsRestore && originalSymbol) {
      try {
        await evaluateAsync(`
          (function() {
            var chart = ${CHART_API};
            return new Promise(function(resolve) {
              chart.setSymbol(${safeString(originalSymbol)}, {});
              setTimeout(resolve, 500);
            });
          })()
        `);
        await waitForChartReady(originalSymbol);
      } catch (e) {}
    }
  }
}

export async function getDepth() {
  const data = await evaluate(`
    (function() {
      var domPanel = document.querySelector('[class*="depth"]')
        || document.querySelector('[class*="orderBook"]')
        || document.querySelector('[class*="dom-"]')
        || document.querySelector('[class*="DOM"]')
        || document.querySelector('[data-name="dom"]');
      if (!domPanel) return { found: false, error: 'DOM / Depth of Market panel not found.' };
      var bids = [], asks = [];
      var rows = domPanel.querySelectorAll('[class*="row"], tr');
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var priceEl = row.querySelector('[class*="price"]');
        var sizeEl = row.querySelector('[class*="size"], [class*="volume"], [class*="qty"]');
        if (!priceEl) continue;
        var price = parseFloat(priceEl.textContent.replace(/[^0-9.\\-]/g, ''));
        var size = sizeEl ? parseFloat(sizeEl.textContent.replace(/[^0-9.\\-]/g, '')) : 0;
        if (isNaN(price)) continue;
        var rowClass = row.className || '';
        var rowHTML = row.innerHTML || '';
        if (/bid|buy/i.test(rowClass) || /bid|buy/i.test(rowHTML)) bids.push({ price, size });
        else if (/ask|sell/i.test(rowClass) || /ask|sell/i.test(rowHTML)) asks.push({ price, size });
        else if (i < rows.length / 2) asks.push({ price, size });
        else bids.push({ price, size });
      }
      if (bids.length === 0 && asks.length === 0) {
        var cells = domPanel.querySelectorAll('[class*="cell"], td');
        var prices = [];
        cells.forEach(function(c) { var val = parseFloat(c.textContent.replace(/[^0-9.\\-]/g, '')); if (!isNaN(val) && val > 0) prices.push(val); });
        if (prices.length > 0) return { found: true, raw_values: prices.slice(0, 50), bids: [], asks: [], note: 'Could not classify bid/ask levels.' };
      }
      bids.sort(function(a, b) { return b.price - a.price; });
      asks.sort(function(a, b) { return a.price - b.price; });
      var spread = null;
      if (asks.length > 0 && bids.length > 0) spread = +(asks[0].price - bids[0].price).toFixed(6);
      return { found: true, bids: bids, asks: asks, spread: spread };
    })()
  `);

  if (!data || !data.found)
    throw new Error(data?.error || 'DOM panel not found.');
  return {
    success: true,
    bid_levels: data.bids?.length || 0,
    ask_levels: data.asks?.length || 0,
    spread: data.spread,
    bids: data.bids || [],
    asks: data.asks || [],
    raw_values: data.raw_values,
    note: data.note,
  };
}

export async function getStudyValues({ wait } = {}) {
  const gate = await gateRead({ wait });
  if (!gate.ok) return gate;
  const data = await evaluate(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var model = chart.model();
      var sources = model.model().dataSources();
      var results = [];
      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;
          var values = {};
          try {
            var dwv = s.dataWindowView();
            if (dwv) {
              var items = dwv.items();
              if (items) {
                for (var i = 0; i < items.length; i++) {
                  var item = items[i];
                  if (item._value && item._value !== '∅' && item._title) values[item._title] = item._value;
                }
              }
            }
          } catch(e) {}
          // Include id + inputs so multiple instances of the same indicator
          // (e.g. two EMAs with different lengths) are distinguishable (#143).
          var id = null;
          try { id = s.id ? s.id() : null; } catch(e) {}
          var inputs = null;
          try { var ip = s.inputs ? s.inputs() : null; if (ip && Object.keys(ip).length) inputs = ip; } catch(e) {}
          if (Object.keys(values).length > 0) results.push({ id: id, name: name, inputs: inputs, values: values });
        } catch(e) {}
      }
      return results;
    })()
  `);
  return {
    success: true,
    study_count: data?.length || 0,
    studies: data || [],
    ...(gate.unsettled_by_request
      ? { settled: false, note: gate.note }
      : { settled: true, settle_ms: gate.settle.elapsed_ms }),
  };
}

export async function getPineLines({ study_filter, verbose, wait } = {}) {
  const gate = await gateRead({ wait });
  if (!gate.ok) return gate;
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwglines', 'lines', filter));
  if (!raw || raw.length === 0)
    return { success: true, study_count: 0, studies: [], ...settleNote(gate) };

  const studies = raw.map((s) => {
    const hLevels = [];
    const seen = {};
    const allLines = [];
    for (const item of s.items) {
      const v = item.raw;
      const y1 = roundPrice(v.y1);
      const y2 = roundPrice(v.y2);
      if (verbose)
        allLines.push({
          id: item.id,
          y1,
          y2,
          x1: v.x1,
          x2: v.x2,
          horizontal: v.y1 === v.y2,
          style: v.st,
          width: v.w,
          color: v.ci,
        });
      if (y1 != null && v.y1 === v.y2 && !seen[y1]) {
        hLevels.push(y1);
        seen[y1] = true;
      }
    }
    hLevels.sort((a, b) => b - a);
    const result = {
      name: s.name,
      total_lines: s.count,
      horizontal_levels: hLevels,
    };
    if (verbose) result.all_lines = allLines;
    return result;
  });
  return { success: true, study_count: studies.length, studies, ...settleNote(gate) };
}

export async function getPineLabels({
  study_filter,
  max_labels,
  verbose,
  wait,
} = {}) {
  const gate = await gateRead({ wait });
  if (!gate.ok) return gate;
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwglabels', 'labels', filter));
  if (!raw || raw.length === 0)
    return { success: true, study_count: 0, studies: [], ...settleNote(gate) };

  const limit = max_labels || 50;
  const studies = raw.map((s) => {
    let labels = s.items
      .map((item) => {
        const v = item.raw;
        const text = v.t || '';
        const price = roundPrice(v.y);
        if (verbose)
          return {
            id: item.id,
            text,
            price,
            x: v.x,
            yloc: v.yl,
            size: v.sz,
            textColor: v.tci,
            color: v.ci,
          };
        return { text, price };
      })
      .filter((l) => l.text || l.price != null);
    if (labels.length > limit) labels = labels.slice(-limit);
    return {
      name: s.name,
      total_labels: s.count,
      showing: labels.length,
      labels,
    };
  });
  return { success: true, study_count: studies.length, studies, ...settleNote(gate) };
}

export async function getPineTables({ study_filter, wait } = {}) {
  const gate = await gateRead({ wait });
  if (!gate.ok) return gate;
  const filter = study_filter || '';
  const raw = await evaluate(
    buildGraphicsJS('dwgtablecells', 'tableCells', filter),
  );
  if (!raw || raw.length === 0)
    return { success: true, study_count: 0, studies: [], ...settleNote(gate) };

  const studies = raw.map((s) => {
    const tables = {};
    for (const item of s.items) {
      const v = item.raw;
      const tid = v.tid || 0;
      if (!tables[tid]) tables[tid] = {};
      if (!tables[tid][v.row]) tables[tid][v.row] = {};
      tables[tid][v.row][v.col] = v.t || '';
    }
    const tableList = Object.entries(tables).map(([tid, rows]) => {
      const rowNums = Object.keys(rows)
        .map(Number)
        .sort((a, b) => a - b);
      const formatted = rowNums
        .map((rn) => {
          const cols = rows[rn];
          const colNums = Object.keys(cols)
            .map(Number)
            .sort((a, b) => a - b);
          return colNums
            .map((cn) => cols[cn])
            .filter(Boolean)
            .join(' | ');
        })
        .filter(Boolean);
      return { rows: formatted };
    });
    return { name: s.name, tables: tableList };
  });
  return { success: true, study_count: studies.length, studies, ...settleNote(gate) };
}

export async function getPineBoxes({ study_filter, verbose, wait } = {}) {
  const gate = await gateRead({ wait });
  if (!gate.ok) return gate;
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwgboxes', 'boxes', filter));
  if (!raw || raw.length === 0)
    return { success: true, study_count: 0, studies: [], ...settleNote(gate) };

  const studies = raw.map((s) => {
    const zones = [];
    const seen = {};
    const allBoxes = [];
    for (const item of s.items) {
      const v = item.raw;
      const high =
        v.y1 != null && v.y2 != null ? roundPrice(Math.max(v.y1, v.y2)) : null;
      const low =
        v.y1 != null && v.y2 != null ? roundPrice(Math.min(v.y1, v.y2)) : null;
      if (verbose)
        allBoxes.push({
          id: item.id,
          high,
          low,
          x1: v.x1,
          x2: v.x2,
          borderColor: v.c,
          bgColor: v.bc,
        });
      if (high != null && low != null) {
        const key = high + ':' + low;
        if (!seen[key]) {
          zones.push({ high, low });
          seen[key] = true;
        }
      }
    }
    zones.sort((a, b) => b.high - a.high);
    const result = { name: s.name, total_boxes: s.count, zones };
    if (verbose) result.all_boxes = allBoxes;
    return result;
  });
  return { success: true, study_count: studies.length, studies, ...settleNote(gate) };
}
