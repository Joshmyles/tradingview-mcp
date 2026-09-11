/**
 * Strategy report access — the primary data channel.
 *
 * INTERNAL. reportData is TradingView's own runtime object, not a public API.
 * It survives CSS churn, which the DOM-scraping path did not, but it will not
 * survive a runtime refactor. Re-verify after every TradingView update.
 *
 * Field semantics are pinned in README.md in this directory. Do not change the
 * normaliser without re-running the verification described there.
 */
import { PATHS } from './paths.js';
import { HELPERS_JS } from './study-state.js';

/**
 * Raw report read. Returns null when no strategy is on the chart, and a
 * `report: null` marker when a strategy exists but TradingView has not
 * computed its report yet.
 *
 * IMPORTANT: this reads whatever is there. It does NOT know whether the report
 * describes the current chart state. A stale report outlives the chart mutation
 * that invalidated it — measured at 0.3s to 7.5s depending on how the mutation
 * was issued. Gate every call on awaitSettled({ requireReport: true }).
 */
export function readReportJs(entityIdExpr = 'null') {
  return `
  (function() {
    ${HELPERS_JS}
    var want = ${entityIdExpr};
    var srcs = __sources();
    var candidates = [];
    for (var i = 0; i < srcs.length; i++) {
      var s = srcs[i];
      if (!__isStrategySource(s)) continue;
      var id = __sourceId(s);
      if (want && id !== want) continue;
      candidates.push({ id: id, s: s });
    }
    if (!candidates.length) return { found: false, strategy_count: 0 };
    /* Prefer one whose report is actually computed: with several strategies on
       the chart only the selected one has a report, so taking the first blindly
       reads an empty one. */
    var picked = null;
    for (var j = 0; j < candidates.length; j++) {
      var rd = __report(candidates[j].s);
      if (rd && rd.performance) { picked = { c: candidates[j], rd: rd }; break; }
    }
    if (!picked) picked = { c: candidates[0], rd: __report(candidates[0].s) };
    var api = __api(picked.c.id);
    var st = null; try { st = api ? api.status() : null; } catch (e) {}
    return {
      found: true,
      strategy_count: candidates.length,
      entity_id: picked.c.id,
      /* Chart identity, read in the SAME expression as the report so a fence
         check compares the chart the report came from, not the chart as it is
         one round-trip later. */
      symbol: (function () { try { return __cw.symbol(); } catch (e) { return null; } })(),
      resolution: (function () { try { return __cw.resolution(); } catch (e) { return null; } })(),
      title: (function () { try { return api.title(); } catch (e) { return null; } })(),
      study_type: st ? st.type : null,
      study_data_length: (function () { try { return api.dataLength(); } catch (e) { return null; } })(),
      report_gen: (window.__tvmcp_gen && window.__tvmcp_gen[picked.c.id] != null)
        ? window.__tvmcp_gen[picked.c.id] : null,
      report_fingerprint: __fingerprint(picked.rd),
      /* Read in the SAME expression as the report, so the fence check cannot
         be defeated by the inputs changing between two round-trips. */
      inputs_hash: __inputsHash(api),
      inputs_digest: __inputsDigest(api),
      report: picked.rd || null
    };
  })()`;
}

/** Long/short is carried by the entry tag, never by the sign of rn/dd. */
const LONG_ENTRY = 'le';
// 'se' is the short-entry tag; direction is derived by testing for LONG_ENTRY.

/**
 * Normalise one raw trade row.
 *
 * Raw shape (verified 2026-09-10 across 105 trades):
 *   e  { c, p, tm, b, tp }  entry: tag, price, epoch ms, bar index, 'le'|'se'
 *   x  { c, p, tm, b, tp }  exit:  tag, price, epoch ms, bar index, 'lx'|'sx'
 *   q                       quantity for THIS row
 *   v                       entry notional = e.p * q
 *   tp { v, p }             realised P&L, NET of commission; p = v / v(notional)
 *   cp { v, p }             cumulative P&L to and including this trade
 *   rn { v, p }             run-up  = MFE, measured from entry, unsigned
 *   dd { v, p }             drawdown = MAE, measured from entry, unsigned
 *   cm                      commission charged to this row
 */
export function normaliseTrade(t, index) {
  const isLong = t.e?.tp === LONG_ENTRY;
  const dir = isLong ? 1 : -1;
  const grossFromPrice = t.x ? dir * (t.x.p - t.e.p) * t.q : null;
  return {
    index,
    direction: isLong ? 'long' : 'short',
    qty: t.q,
    entry: {
      tag: t.e?.c ?? null,
      // Preserved as a parsed field: entry tags are the metadata channel, so a
      // caller should never have to re-split a string we already split.
      tag_tokens: typeof t.e?.c === 'string' ? t.e.c.trim().split(/\s+/) : [],
      price: t.e?.p ?? null,
      time: t.e?.tm ?? null,
      bar: t.e?.b ?? null,
    },
    exit: t.x
      ? {
          tag: t.x.c ?? null,
          tag_tokens: typeof t.x.c === 'string' ? t.x.c.trim().split(/\s+/) : [],
          price: t.x.p ?? null,
          time: t.x.tm ?? null,
          bar: t.x.b ?? null,
        }
      : null,
    net_profit: t.tp?.v ?? null,
    net_profit_pct: t.tp?.p ?? null,
    cumulative_profit: t.cp?.v ?? null,
    // MFE and MAE, both measured from THIS row's entry price, both unsigned.
    mfe: t.rn?.v ?? null,
    mae: t.dd?.v ?? null,
    mfe_pct: t.rn?.p ?? null,
    mae_pct: t.dd?.p ?? null,
    commission: t.cm ?? null,
    entry_notional: t.v ?? null,
    gross_profit: grossFromPrice == null ? null : round8(grossFromPrice),
    bars_held: t.x && t.e ? t.x.b - t.e.b : null,
  };
}

const round8 = (v) => Math.round(v * 1e8) / 1e8;

/**
 * Reconcile trade rows against filled orders, and re-derive P&L from prices.
 *
 * Both checks exist because a report that looks plausible is the failure mode
 * we are defending against. If the arithmetic stops holding, the field
 * semantics have changed underneath us and every downstream number is suspect.
 *
 * Verified 2026-09-10 on build 14 / 45S / Aug 26–Sep 10:
 *   105 trades, 198 filled orders = 105 entry + 93 exit.
 *   The 12-row gap is entirely explained by 8 multi-quantity CLOSE orders
 *   (four q=3, four q=2): TradingView splits one position-level close into one
 *   trade row per open leg. 4*(3-1) + 4*(2-1) = 12. Exactly.
 */
/**
 * Flag the rows that describe a position that is still OPEN.
 *
 * TradingView does not omit the exit for an open position — it synthesises
 * one. Measured 2026-09-10 at the live edge, the trailing row carried a full
 * `x` object with an empty comment, a price that MOVED between two reads
 * seconds apart (4335.39 -> 4332.97, net 16.78 -> 19.20), and `cm` charging
 * ONE side while `tp.v` was computed net of the round trip. So:
 *
 *   - `t.exit === null` never fires, and the reconciler counted 0 open rows;
 *   - the fill identity was short by exactly one row (106 explained of 107);
 *   - the P&L identity was off by exactly one commission side (0.11).
 *
 * Both symptoms had one cause, and the reconciler correctly refused the book
 * while misattributing why.
 *
 * The authoritative marker is `performance.all.totalOpenTrades`, with
 * `totalTrades` counting only CLOSED rows. Open rows are the trailing ones.
 * An empty exit comment corroborates but is not relied on — a Pine strategy
 * may legitimately close without one.
 *
 * An open row's net, MAE and MFE are mark-to-market and will differ on the
 * next tick. They are excluded from the identities and marked `is_open` so a
 * caller does not put a moving number into a distribution.
 */
export function markOpenTrades(report, trades) {
  const all = report?.performance?.all || {};
  const openCount = Number(all.totalOpenTrades) || 0;
  if (openCount > 0) {
    for (let i = Math.max(0, trades.length - openCount); i < trades.length; i++) {
      trades[i].is_open = true;
    }
  }
  return { open_count: openCount, closed_reported: all.totalTrades ?? null };
}

export function reconcile(report, trades) {
  const orders = report.filledOrders || [];
  const entryOrders = orders.filter((o) => o.e === true);
  const exitOrders = orders.filter((o) => o.e === false);
  const excessFromMultiQty = exitOrders.reduce((a, o) => a + Math.max(0, (o.q || 1) - 1), 0);
  // An open position has an entry fill and no exit fill, whether or not
  // TradingView synthesised an exit object for it.
  const openRows = trades.filter((t) => t.exit === null || t.is_open === true).length;

  const expected = exitOrders.length + excessFromMultiQty + openRows;
  const rowsExplained = expected === trades.length;

  // P&L identity: net = direction * (exit - entry) * qty - commission.
  let maxPnlErr = 0;
  let checked = 0;
  for (const t of trades) {
    if (t.gross_profit == null || t.net_profit == null) continue;
    // An open row's exit price is mark-to-market and its commission is
    // one-sided; the identity does not apply and asserting it anyway reports a
    // 0.11 error that means nothing.
    if (t.is_open) continue;
    checked++;
    maxPnlErr = Math.max(maxPnlErr, Math.abs(t.gross_profit - t.commission - t.net_profit));
  }

  // MAE/MFE identity: both are measured from entry, so they must bound the
  // realised gross move. A violation means dd/rn are no longer excursions.
  const closed = trades.filter((t) => !t.is_open);
  const maeViolations = closed.filter(
    (t) => t.mae != null && t.gross_profit != null && t.mae < Math.max(0, -t.gross_profit) - 1e-6,
  ).length;
  const mfeViolations = closed.filter(
    (t) => t.mfe != null && t.gross_profit != null && t.mfe < Math.max(0, t.gross_profit) - 1e-6,
  ).length;
  const signViolations = closed.filter((t) => t.mae < 0 || t.mfe < 0).length;

  // Quantity > 1 on a TRADE row is not covered by the verification described in
  // README.md — every row in the verified dataset was q=1, because multi-leg
  // exits are split into one q=1 row per leg. Whether mae/mfe/net are
  // position-totals or per-unit when a row itself carries q>1 is UNTESTED.
  const multiQtyRows = trades.filter((t) => (t.qty || 1) > 1).map((t) => t.index);

  return {
    trades: trades.length,
    filled_orders: orders.length,
    entry_orders: entryOrders.length,
    exit_orders: exitOrders.length,
    multi_qty_exit_excess: excessFromMultiQty,
    open_rows: openRows,
    ...(openRows
      ? {
          open_rows_note:
            'A position is still open. Its row carries a synthesised mark-to-market exit whose price, net, MAE and MFE change on every tick, and a one-sided commission. It is marked is_open and excluded from the identities; exclude it from any distribution too.',
        }
      : {}),
    rows_explained: rowsExplained,
    ...(rowsExplained
      ? {}
      : {
          reconciliation_error: `Trade rows (${trades.length}) are not explained by fills (${exitOrders.length} exits + ${excessFromMultiQty} split legs + ${openRows} open = ${expected}). Treat the book as suspect.`,
        }),
    pnl_identity: {
      rows_checked: checked,
      max_abs_error: round8(maxPnlErr),
      holds: maxPnlErr < 1e-6,
    },
    excursion_identity: {
      mae_violations: maeViolations,
      mfe_violations: mfeViolations,
      sign_violations: signViolations,
      holds: maeViolations === 0 && mfeViolations === 0 && signViolations === 0,
    },
    ...(multiQtyRows.length && {
      unverified_multi_qty_rows: multiQtyRows,
      unverified_multi_qty_warning:
        'One or more trade rows carry qty > 1. Whether mae/mfe/net_profit are position-totals or per-unit in that case is UNVERIFIED (see src/internals/README.md). Do not size stops from these rows without checking.',
    }),
  };
}

/**
 * Normalise one filled-order row.
 *
 * Verified 2026-09-10: `ordersData()` and `reportData().filledOrders` are the
 * SAME array object (identity-equal, 198 rows on build 14). There is no second
 * order channel to reconcile against — reading either reads the same thing.
 *
 * Raw shape: { id, tp, b, e, p, q, tm, c }
 *   id  order id ("Close position order", or a Pine order id)
 *   tp  order TYPE string ('STOP', 'MARKET', ...) — NOT the P&L object that
 *       `tp` denotes on a TRADE row. The key is overloaded across the two
 *       shapes; do not share a mapper between them.
 *   b   true = buy side
 *   e   true = this order OPENED a position, false = it closed one
 *   tm  bar sequence number, not a timestamp (see README)
 *   c   the order tag — the same metadata channel as an entry tag
 */
export function normaliseOrder(o, index) {
  return {
    index,
    id: o.id ?? null,
    order_type: o.tp ?? null,
    side: o.b ? 'buy' : 'sell',
    is_entry: o.e === true,
    tag: o.c ?? null,
    tag_tokens: typeof o.c === 'string' ? o.c.trim().split(/\s+/) : [],
    price: o.p ?? null,
    qty: o.q ?? null,
    bar_seq: o.tm ?? null,
  };
}

/**
 * Per-trade equity curve.
 *
 * `reportData` has NO `equity` or `equityChart` field — verified absent
 * 2026-09-10, so the code that looked for them was reading a field TradingView
 * has never emitted. What does exist is `trades[].cp.v`, the running cumulative
 * P&L, which is a genuine trade-by-trade equity curve, and `buyHold`
 * (length = trades + 1, based at 100) as its aligned baseline.
 *
 * This is per CLOSED TRADE, not per bar. TradingView does not expose a per-bar
 * account curve through this object; anything claiming to be one is inferred.
 */
export function normaliseEquity(report, trades) {
  const buyHold = Array.isArray(report.buyHold) ? report.buyHold : [];
  const buyHoldPct = Array.isArray(report.buyHoldPercent)
    ? report.buyHoldPercent
    : [];
  const points = trades
    .filter((t) => t.cumulative_profit != null)
    .map((t, i) => ({
      trade_index: t.index,
      bar: t.exit?.bar ?? null,
      time: t.exit?.time ?? null,
      cumulative_profit: t.cumulative_profit,
      buy_hold: buyHold.length > i + 1 ? buyHold[i + 1] : null,
      buy_hold_pct: buyHoldPct.length > i + 1 ? buyHoldPct[i + 1] : null,
    }));
  return {
    basis: 'per_closed_trade',
    per_bar_available: false,
    points,
  };
}

/** Headline metrics, named as the Strategy Tester names them. */
export function normalisePerformance(report) {
  const perf = report.performance || {};
  const all = perf.all || {};
  return {
    currency: report.currency ?? null,
    net_profit: all.netProfit ?? null,
    gross_profit: all.grossProfit ?? null,
    gross_loss: all.grossLoss ?? null,
    profit_factor: all.profitFactor ?? null,
    percent_profitable: all.percentProfitable ?? null,
    winning_trades: all.numberOfWiningTrades ?? null,
    losing_trades: all.numberOfLosingTrades ?? null,
    total_trades:
      (all.numberOfWiningTrades ?? 0) + (all.numberOfLosingTrades ?? 0) || null,
    commission_paid: all.commissionPaid ?? null,
    avg_bars_in_trade: all.avgBarsInTrade ?? null,
    max_contracts_held: all.maxContractsHeld ?? null,
    net_profit_pct: all.netProfitPercent ?? null,
    avg_trade: all.avgTrade ?? null,
    largest_win: all.largestWinTrade ?? null,
    // TradingView's own spelling. Not a typo here.
    largest_loss: all.largestLosTrade ?? null,
    sharpe_ratio: perf.sharpeRatio ?? null,
    sortino_ratio: perf.sortinoRatio ?? null,
    max_drawdown: perf.maxStrategyDrawDown ?? null,
    max_drawdown_pct: perf.maxStrategyDrawDownPercent ?? null,
    max_run_up: perf.maxStrategyRunUp ?? null,
    max_run_up_pct: perf.maxStrategyRunUpPercent ?? null,
    buy_hold_return: perf.buyHoldReturn ?? null,
    open_pl: perf.openPL ?? null,
  };
}

/**
 * The window the report actually covers.
 *
 * `backtest` is the requested range; `trade` spans first entry to last exit.
 * On a live chart `backtest.to` advances with every new bar (measured: +30s
 * per bar on a 30S chart), so it is never a stable identity — use
 * `backtest.from` when fencing state.
 */
export function normaliseWindow(report) {
  const dr = report.settings?.dateRange || {};
  return {
    backtest_from: dr.backtest?.from ?? null,
    backtest_to: dr.backtest?.to ?? null,
    trade_from: dr.trade?.from ?? null,
    trade_to: dr.trade?.to ?? null,
    backtest_to_is_live_edge: true,
  };
}

export { PATHS };
