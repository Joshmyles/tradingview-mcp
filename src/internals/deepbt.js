/**
 * Deep Backtesting — the only way to run a strategy over an explicit window.
 *
 * INTERNAL — see paths.js. Re-verify after every TradingView update.
 *
 * ## Why this exists, and what does NOT
 *
 * The walk-forward was specified against `dateRange.backtest`. Probed on
 * Desktop 3.4.1: **that is not a setting.** `reportData().settings.dateRange`
 * is engine OUTPUT describing the range the strategy actually ran over, which
 * follows the loaded bar history. It appears nowhere in the study's property
 * tree — `properties().childs().strategy` holds only `orders.{showLabels,
 * showQty,visible}` — and no `date`/`range`/`backtest` writable exists on the
 * chart widget, the model, or the study. Searched and not found; there is
 * nothing to set.
 *
 * What does exist is Deep Backtesting, which takes an explicit `(from, to)`
 * and runs server-side. Measured 2026-09-10 on Desktop 3.4.1: a 7-day 45S
 * window returned 51 trades in 20 seconds. It is better than the specified
 * mechanism for this purpose — the window is explicit, the run does not depend
 * on how much history the chart has scrolled in, and it does not churn the
 * chart at all.
 *
 * **It is NOT the intrabar-detail correction, and an earlier draft of this
 * file said it was.** Measured directly: a deep run over the same window as
 * the on-chart book, matched trade-for-trade on entry time, price and
 * direction, gave 99 identical MAE values out of 100 matches. The single
 * difference was a trade clipped by the window edge, and its deep MAE was
 * LOWER. Deep Backtesting extends history depth; it does not resolve intrabar
 * path. `drawdown.value` from a deep run is the same bar-extreme excursion the
 * chart reports, and anything waiting on a detalization correction is still
 * waiting.
 *
 * ## How it is reached
 *
 * Not through any public API. The backtesting React context is found by
 * walking React fibers from every `__reactContainer*` root for a
 * `memoizedProps.value` carrying `_deepBacktestingManager`. The Strategy
 * Tester panel must be mounted. Cached on `window.__tvmcp_bt` so the walk —
 * ~2,000 fiber nodes — happens once per page.
 *
 * ## The trap
 *
 * **The deep report stays cached after a run, and the status reads 2 (done)
 * for the PREVIOUS window's report.** That is the level-predicate trap from
 * the internals README in a new place: poll status, see "done", read the wrong
 * window's book, and nothing anywhere says so. Two defences, both required:
 *
 *   1. A `done` EDGE counted since the request was issued. This is the only
 *      real proof. `resetDeepBacktestingReportData()` is called first but
 *      **measured, it does not clear the cache**: immediately after calling
 *      it, the poll still read status 2 with the previous run's 51 trades and
 *      window. Do not rely on it.
 *   2. The returned `settings.dateRange.backtest` is checked for overlap with
 *      the request. TradingView SNAPS the window to available data — asking
 *      for 1787695320000..1788300000000 returned 1787616030000..1788220785000
 *      — so equality is the wrong test and would reject every valid run. The
 *      actual window is always returned to the caller; never assume the
 *      requested one was used. Note this check is WEAK on its own: two
 *      different requests snapped to the same window, so overlap cannot
 *      distinguish a fresh report from the cached one. The edge does.
 *
 * ## Two subscription conventions on one page
 *
 * `_statusDeepBacktesting` is a WatchedValue: `subscribe(callback, options)`.
 * `mainSeries().dataEvents().loading()` is a Delegate: `subscribe(owner,
 * callback)`. Passing the Delegate shape to the WatchedValue throws
 * "callback must be a function" — and because the counter is installed inside
 * a try/catch that only records the failure, the visible symptom was not an
 * error but a five-minute timeout reporting that a run which had in fact
 * finished "never started".
 *
 * ## Field shape
 *
 * Deep report trades are NOT the terse on-chart shape (`e`/`x`/`tp`/`rn`/`dd`).
 * They are spelled out:
 *
 *   entry/exit  { id, price, time, type, barIndex }   id = the tag, type le/se/lx/sx
 *   profit      { value, percentValue }               value is NET of commission
 *   drawdown    { value, percentValue }               MAE, unsigned, from this entry
 *   runup       { value, percentValue }               MFE, unsigned
 *   quantity, commission, tradeNumber
 *
 * `normaliseDeepTrade` maps them onto the SAME output shape as
 * `normaliseTrade` in report.js, so a deep window and an on-chart read are
 * comparable without the caller knowing which produced them.
 *
 * `equity` and `equityChart` are absent here too — the same gap recorded in
 * PROVENANCE. A deep report carries `filledOrders` (93 for 51 trades), which
 * is what a per-bar reconstruction would be built from.
 */

/**
 * Deep-backtesting status enum — a THIRD status vocabulary, unrelated to the
 * study enum and the series enum in paths.js.
 *
 * Measured: null before any run, 1 while running (with a `startTime`), 2 when
 * done. Unexported for the same reason as the other two: three enums with
 * overlapping small integers and opposed meanings, on objects reachable from
 * the same page, is a mistake waiting to be made silently.
 */
const DEEPBT_STATUS = { RUNNING: 1, DONE: 2, ERROR: 3 };

export const __DEEPBT_STATUS_INTERNAL_ONLY = { DEEPBT_STATUS };

/** Install (idempotently) the context hook and a status edge counter. */
export const DEEPBT_HOOK_JS = `
  (function() {
    /* The context and the edge counter are installed independently on purpose.
       Finding the context is expensive and cacheable; the counter is cheap and
       must exist whenever the context does. An earlier version returned early
       on a cached context and left the counter uninstalled, so every poll saw
       edges: null and deepBtCompleted could never be satisfied — the run
       "never started" for five minutes while it was in fact finishing. */
    var cached = !!(window.__tvmcp_bt && window.__tvmcp_bt._deepBacktestingManager);
    var found = cached ? window.__tvmcp_bt : null;
    function walk(n, d) {
      if (!n || d > 60 || found) return;
      try {
        var v = n.memoizedProps && n.memoizedProps.value;
        if (v && typeof v === 'object' && v._deepBacktestingManager) { found = v; return; }
      } catch (e) { /* fiber nodes throw on some getters */ }
      if (n.child) walk(n.child, d + 1);
      if (n.sibling) walk(n.sibling, d);
    }
    if (!found) {
      var els = document.querySelectorAll('*');
      for (var i = 0; i < els.length && !found; i++) {
        for (var k in els[i]) {
          if (k.indexOf('__reactContainer') === 0) { walk(els[i][k], 0); if (found) break; }
        }
      }
    }
    if (!found) {
      return {
        installed: false,
        reason: 'backtesting context not found — the Strategy Tester panel must be open'
      };
    }
    window.__tvmcp_bt = found;
    if (window.__tvmcp_bt_edges && window.__tvmcp_bt_edges.subscribed) {
      return { installed: true, cached: cached, edges: window.__tvmcp_bt_edges };
    }
    /* Edge counter on the status, per the level-predicate rule: a cached
       report reads "done" forever, so a transition is the only evidence that
       THIS request produced THIS report. */
    window.__tvmcp_bt_edges = { running: 0, done: 0, last: null };
    try {
      var wv = found._deepBacktestingManager._statusDeepBacktesting;
      /* subscribe(callback, options) -- a WatchedValue, NOT a Delegate.
         mainSeries().dataEvents() delegates take subscribe(owner, callback),
         and passing that shape here throws "callback must be a function".
         Two subscription conventions on one page; see the note in this file. */
      wv.subscribe(function (s) {
        var t = s && s.type;
        if (t === ${DEEPBT_STATUS.RUNNING}) window.__tvmcp_bt_edges.running++;
        if (t === ${DEEPBT_STATUS.DONE}) window.__tvmcp_bt_edges.done++;
        window.__tvmcp_bt_edges.last = t;
      });
      window.__tvmcp_bt_edges.subscribed = true;
    } catch (e) {
      window.__tvmcp_bt_edges.subscribed = false;
      window.__tvmcp_bt_edges.error = e.message;
    }
    return { installed: true, cached: false, edges: window.__tvmcp_bt_edges };
  })()`;

/**
 * Clear the cached report, switch the tester to the deep stream, and request.
 *
 * The reset is not optional. Without it the previous window's book is still
 * there, still reporting status 2.
 */
export function deepBtRequestJs(from, to) {
  return `
  (function() {
    var ctx = window.__tvmcp_bt;
    if (!ctx) return { ok: false, error: 'not hooked' };
    var edgesBefore = window.__tvmcp_bt_edges
      ? { running: window.__tvmcp_bt_edges.running, done: window.__tvmcp_bt_edges.done }
      : null;
    try {
      if (typeof ctx.resetDeepBacktestingReportData === 'function') {
        ctx.resetDeepBacktestingReportData();
      }
    } catch (e) { /* nothing cached */ }
    try { ctx.setReportDataSource(true); }
    catch (e) { return { ok: false, error: 'setReportDataSource: ' + e.message }; }
    try { ctx.requestDeepBacktestingData(${Number(from)}, ${Number(to)}); }
    catch (e) { return { ok: false, error: 'requestDeepBacktestingData: ' + e.message }; }
    return { ok: true, requested: { from: ${Number(from)}, to: ${Number(to)} }, edges_before: edgesBefore };
  })()`;
}

/** Cheap poll: status, edge counts, and the window the engine reports. */
export const DEEPBT_POLL_JS = `
  (function() {
    var ctx = window.__tvmcp_bt;
    if (!ctx) return { kind: 'deepbt', hooked: false };
    var m = ctx._deepBacktestingManager;
    var status = null;
    try { status = m._statusDeepBacktesting.value(); } catch (e) { /* never run */ }
    var rd = null;
    try { rd = m._reportDataDeepBacktesting.value(); } catch (e) { /* not ready */ }
    var win = null;
    try { win = { from: rd.settings.dateRange.backtest.from, to: rd.settings.dateRange.backtest.to }; }
    catch (e) { /* no report yet */ }
    return {
      kind: 'deepbt',
      hooked: true,
      status_type: status ? status.type : null,
      started_at: status ? status.startTime || null : null,
      report_present: !!rd,
      trades: rd && rd.trades ? rd.trades.length : null,
      window: win,
      edges: window.__tvmcp_bt_edges
        ? { running: window.__tvmcp_bt_edges.running, done: window.__tvmcp_bt_edges.done }
        : null
    };
  })()`;

/** The whole deep report, structured-cloned out of the page. */
export const DEEPBT_READ_JS = `
  (function() {
    var m = window.__tvmcp_bt && window.__tvmcp_bt._deepBacktestingManager;
    if (!m) return { ok: false, error: 'not hooked' };
    var rd = null;
    try { rd = m._reportDataDeepBacktesting.value(); } catch (e) { return { ok: false, error: e.message }; }
    if (!rd) return { ok: false, error: 'no deep report' };
    var out = { ok: true };
    try {
      out.trades = JSON.parse(JSON.stringify(rd.trades || []));
      out.filled_orders = JSON.parse(JSON.stringify(rd.filledOrders || []));
      out.performance = JSON.parse(JSON.stringify(rd.performance || {}));
      out.window = JSON.parse(JSON.stringify(rd.settings && rd.settings.dateRange ? rd.settings.dateRange : {}));
      out.max_strategy_drawdown = rd.maxStrategyDrawDown != null ? rd.maxStrategyDrawDown : null;
      out.sharpe_ratio = rd.sharpeRatio != null ? rd.sharpeRatio : null;
      out.sortino_ratio = rd.sortinoRatio != null ? rd.sortinoRatio : null;
      out.equity_present = !!(rd.equity || rd.equityChart);
    } catch (e) { return { ok: false, error: 'serialise: ' + e.message }; }
    return out;
  })()`;

/**
 * Put the Strategy Tester back on the live chart stream.
 *
 * Always call it. Leaving the tester on the deep stream means the next
 * on-chart read is looking at a different window than the chart shows, which
 * is the same class of bug as attaching to the wrong page context.
 */
export const DEEPBT_RESTORE_JS = `
  (function() {
    try { window.__tvmcp_bt.setReportDataSource(false); return { restored: true }; }
    catch (e) { return { restored: false, error: e.message }; }
  })()`;

const LONG_ENTRY = 'le';
const round8 = (v) => Math.round(v * 1e8) / 1e8;

/**
 * Map a deep-report trade onto the shape `normaliseTrade` produces.
 *
 * Same field names, same units, same sign conventions, so an aggregate over a
 * deep window and an aggregate over the on-chart book are comparable without
 * the caller knowing which one it has. `source` says which it was.
 */
export function normaliseDeepTrade(t, index) {
  const isLong = t.entry?.type === LONG_ENTRY;
  const dir = isLong ? 1 : -1;
  const gross =
    t.exit && t.entry ? dir * (t.exit.price - t.entry.price) * (t.quantity ?? 0) : null;
  const tokens = (s) => (typeof s === 'string' ? s.trim().split(/\s+/) : []);
  return {
    index,
    source: 'deep_backtest',
    direction: isLong ? 'long' : 'short',
    qty: t.quantity ?? null,
    entry: {
      tag: t.entry?.id ?? null,
      tag_tokens: tokens(t.entry?.id),
      price: t.entry?.price ?? null,
      time: t.entry?.time ?? null,
      bar: t.entry?.barIndex ?? null,
    },
    exit: t.exit
      ? {
          tag: t.exit.id ?? null,
          tag_tokens: tokens(t.exit.id),
          price: t.exit.price ?? null,
          time: t.exit.time ?? null,
          bar: t.exit.barIndex ?? null,
        }
      : null,
    net_profit: t.profit?.value ?? null,
    net_profit_pct: t.profit?.percentValue ?? null,
    cumulative_profit: t.cumulativeProfit?.value ?? null,
    mfe: t.runup?.value ?? null,
    mae: t.drawdown?.value ?? null,
    mfe_pct: t.runup?.percentValue ?? null,
    mae_pct: t.drawdown?.percentValue ?? null,
    commission: t.commission ?? null,
    entry_notional: null,
    gross_profit: gross == null ? null : round8(gross),
    bars_held: t.exit && t.entry ? t.exit.barIndex - t.entry.barIndex : null,
    trade_number: t.tradeNumber ?? null,
  };
}

/** Deep filled orders, mapped onto the on-chart order shape. */
export function normaliseDeepOrder(o, index) {
  return {
    index,
    source: 'deep_backtest',
    is_entry: o.isEntry === true,
    side: o.isBuy ? 'buy' : 'sell',
    order_id: o.id ?? null,
    tag: o.comment ?? null,
    price: o.price ?? null,
    qty: o.quantity ?? null,
    bar: o.barTime ?? null,
    type: o.type ?? null,
  };
}

/** Deep performance, mapped onto `normalisePerformance`'s field names. */
export function normaliseDeepPerformance(perf, extra = {}) {
  const all = perf?.all || {};
  return {
    net_profit: all.netProfit ?? null,
    gross_profit: all.grossProfit ?? null,
    gross_loss: all.grossLoss ?? null,
    profit_factor: all.profitFactor ?? null,
    total_trades: all.totalTrades ?? null,
    winning_trades: all.numberOfWiningTrades ?? null,
    losing_trades: all.numberOfLosingTrades ?? null,
    percent_profitable: all.percentProfitable ?? null,
    avg_trade: all.avgTrade ?? null,
    avg_win: all.avgWinTrade ?? null,
    avg_loss: all.avgLosTrade ?? null,
    largest_win: all.largestWinTrade ?? null,
    largest_loss: all.largestLosTrade ?? null,
    commission_paid: all.commissionPaid ?? null,
    avg_bars_in_trade: all.avgBarsInTrade ?? null,
    max_drawdown: extra.max_strategy_drawdown ?? null,
    // TradingView's own, from a per-bar curve this bridge cannot read. Carried
    // for reference only — see PROVENANCE "Known gaps".
    sharpe_ratio_tradingview: extra.sharpe_ratio ?? null,
    sortino_ratio_tradingview: extra.sortino_ratio ?? null,
  };
}
