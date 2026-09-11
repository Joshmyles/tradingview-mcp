/**
 * Equity-curve recipe: reconstruct the per-bar curve for the on-chart book.
 *
 * Sequence, and why it is this order:
 *
 *   1. Read the report through the gate, to learn which window the book covers.
 *   2. Extend loaded price history until it reaches the start of that window.
 *      The series holds a viewport-sized rolling cache, not the backtest range
 *      (measured: 372 loaded bars against a 21,518-bar book).
 *   3. Re-read the report. Extending history moves `dateRange.backtest.from`,
 *      because the backtest range follows the loaded bars. Pairing bars from
 *      after step 2 with a book from before it reconstructs a curve for a book
 *      that no longer exists, and every number would look plausible.
 *   4. Read the bars, reconstruct, validate against the report's own MAE/MFE.
 *
 * Step 3 is the one that is easy to skip and impossible to detect afterwards.
 */
import { evaluate, evaluateAsync } from '../connection.js';
import { readStrategyReport } from '../strategy-report.js';
import {
  BARS_EXTENT_JS,
  barsSliceJs,
  curveStats,
  ensureHistoryJs,
  excursionPaths,
  perTradeRatios,
  prepareBars,
  reconstructEquity,
  samplingSensitivity,
  summariseExcursionPaths,
  tighteningBenefit,
  tradingviewComparison,
} from '../internals/equity.js';

/**
 * Bars per round trip. Bounded because the whole slice is materialised as JSON
 * on both sides; at 21k bars a single read is a multi-megabyte string with no
 * upside over five smaller ones.
 */
const SLICE = 5000;

/**
 * Read every loaded bar, in slices, from one settled extent.
 *
 * The extent is read once and the slices are cut from it. If the series
 * reloads mid-loop the slice indices rebase underneath us, so the extent is
 * re-checked at the end and a move is reported as a failure rather than
 * stitched over.
 */
async function readAllBars(ev) {
  const extent = await ev(BARS_EXTENT_JS);
  if (!extent || !extent.size) {
    return { ok: false, reason: 'no_bars', error: 'The price series holds no bars.' };
  }
  const rows = [];
  for (let from = extent.first; from <= extent.last; from += SLICE) {
    const slice = await ev(barsSliceJs(from, Math.min(from + SLICE - 1, extent.last)));
    if (!slice?.rows) {
      return { ok: false, reason: 'bar_read_failed', error: `Bar slice from ${from} returned nothing.` };
    }
    for (const row of slice.rows) rows.push(row);
  }
  const after = await ev(BARS_EXTENT_JS);
  if (!after || after.first !== extent.first || after.t_first !== extent.t_first) {
    return {
      ok: false,
      reason: 'series_moved',
      error:
        'The price series rebased while its bars were being read, so the slices do not describe one continuous history. Retry on a settled chart.',
      before: extent,
      after,
    };
  }
  return { ok: true, rows, extent, appended: after.last - extent.last };
}

/**
 * Reconstruct the per-bar mark-to-market curve for the current on-chart book.
 *
 * `include: ['curve']` returns the curve itself, downsampled. It is off by
 * default for the same reason the trade book is: 21,675 points is not an
 * answer, it is a file.
 */
export async function equityCurve({
  entityId = null,
  include = [],
  maxHistoryRounds = 8,
  _deps,
} = {}) {
  const ev = _deps?.evaluate || evaluate;
  // ensureHistoryJs resolves a Promise; a plain evaluate returns undefined for
  // one and the caller cannot tell that from a failure to load.
  const evAsync = _deps?.evaluateAsync || evaluateAsync;
  const read = _deps?.readStrategyReport || readStrategyReport;
  const want = new Set(include);

  const first = await read({ entityId, includeOrders: false });
  if (!first.ok) return first;
  const wantFrom = first.window?.backtest_from;
  if (wantFrom == null) {
    return {
      ok: false,
      reason: 'no_window',
      error: 'The report does not carry a backtest window, so there is nothing to load history to.',
    };
  }

  const history = await evAsync(ensureHistoryJs(Math.floor(wantFrom / 1000), 10000, maxHistoryRounds));

  // Re-read unconditionally. Even when history already covered the window, the
  // second read costs one gated round trip and removes the only way this
  // function can lie.
  const report = await read({ entityId: entityId || first.entity_id, includeOrders: false });
  if (!report.ok) return report;

  const bars = await readAllBars(ev);
  if (!bars.ok) return bars;

  const prepared = prepareBars(bars.rows);
  const rec = reconstructEquity(report.trades, prepared);
  if (rec.history_short_error) {
    return {
      ok: false,
      reason: 'history_too_short',
      error: rec.history_short_error,
      legs_outside_loaded_history: rec.legs_outside_loaded_history,
      unplaced_trade_indexes: rec.unplaced_trade_indexes,
      history,
      loaded_bars: prepared.n,
      loaded_from: prepared.n ? prepared.times[0] : null,
      backtest_from: report.window.backtest_from,
    };
  }

  const paths = excursionPaths(rec.placed, prepared);
  const stats = curveStats(rec, prepared);

  // Cross-check the reconstruction against the report's own headline. These
  // are computed from different things -- a curve of marks versus a sum of
  // realised legs -- so agreement is evidence the join is right.
  const reportedNet = report.performance?.net_profit ?? null;
  const openPl = report.performance?.open_pl ?? null;
  const closedNet = stats.net_profit;
  // Commission is a per-leg round trip charged half on each side; every row in
  // the book carries the same figure, so one row is enough to state the bound.
  const halfCommission = (report.trades.find((t) => t.commission != null)?.commission ?? 0) / 2;
  const r4 = (v) => Math.round(v * 1e4) / 1e4;

  return {
    ok: true,
    entity_id: report.entity_id,
    window: report.window,
    history: {
      requested_to: wantFrom,
      covered: history?.covered === true,
      rounds: history?.rounds ?? 0,
      bars_before: history?.started?.size ?? null,
      bars_after: prepared.n,
      ...(history?.covered === false && { not_covered_reason: history.reason }),
    },
    reconstruction: {
      legs_placed: rec.legs_placed,
      open_rows_excluded: rec.open_rows_excluded,
      commission_realised: rec.commission_realised,
      unrealised_excludes_commission: rec.unrealised_excludes_commission,
      excursion_validation: paths.validation,
      // The curve's final value is the sum of the closed legs. TradingView's
      // netProfit is that MINUS the entry-side commission already charged on
      // any position still open -- measured as exactly -0.11 against a 0.22
      // round trip on a book with one open leg. openPL is reported separately
      // and is in neither number. So the residual is expected, small, and
      // bounded by the open legs' entry commission; anything larger means the
      // curve and the report disagree about the book.
      closes_vs_report: {
        curve_final: closedNet,
        report_net_profit: reportedNet,
        report_open_pl: openPl,
        residual: reportedNet == null ? null : Math.round((reportedNet - closedNet) * 1e4) / 1e4,
        residual_expected_bound: r4(-(rec.open_rows_excluded * halfCommission)),
        residual_note:
          'Expected to be the entry-side commission on the still-open legs, which TradingView charges to netProfit and this curve does not carry. openPL is in neither. A residual outside that bound is a real disagreement about the book.',
      },
    },
    risk: stats,
    sampling_sensitivity: samplingSensitivity(rec, prepared),
    per_trade: perTradeRatios(rec.placed, prepared),
    tradingview_reported: {
      sharpe_ratio: report.performance?.sharpe_ratio ?? null,
      sortino_ratio: report.performance?.sortino_ratio ?? null,
      max_drawdown: report.performance?.max_drawdown ?? null,
      max_run_up: report.performance?.max_run_up ?? null,
      note: 'TradingView computes these from a curve it does not expose, by a method it does not document. The block below identifies the method by testing candidates against the reconstruction rather than assuming one.',
      // Recomputed on every run rather than quoted from a past run: the book
      // rolls, and a gap that has been explained once still has to hold.
      method: tradingviewComparison(rec, prepared, report.performance, stats),
    },
    excursion_timing: summariseExcursionPaths(paths.rows),
    ...(want.has('tightening') && {
      // Sizing, not a fit. Measured 2026-09-11 on the 45S book: negative at
      // every arm level whose sign is stable across a split-half, positive
      // only at arms 5 and 6 where the sign FLIPS between halves -- the same
      // signature that refuted the fixed stop level.
      tightening_benefit: tighteningBenefit(rec.placed, prepared),
    }),
    ...(want.has('paths') && { excursion_paths: paths.rows }),
    ...(want.has('curve') && { curve: downsample(rec, prepared, 500) }),
  };
}

/**
 * Downsample the curve for transport.
 *
 * Takes the LAST point of each bucket rather than an average: the curve is a
 * running total, and averaging a running total produces a line that is nowhere
 * equal to it. The extremes are kept exactly so a drawdown read off the
 * downsampled curve is the real one.
 */
function downsample(rec, bars, target) {
  const n = rec.equity.length;
  const step = Math.max(1, Math.ceil(n / target));
  const keep = new Set([0, n - 1]);
  for (let i = 0; i < n; i += step) keep.add(i);
  let hi = 0;
  let lo = 0;
  for (let i = 1; i < n; i++) {
    if (rec.equity[i] > rec.equity[hi]) hi = i;
    if (rec.equity[i] < rec.equity[lo]) lo = i;
  }
  keep.add(hi);
  keep.add(lo);
  const points = [...keep]
    .sort((a, b) => a - b)
    .map((i) => [bars.times[i], Math.round(rec.equity[i] * 100) / 100]);
  return {
    basis: 'per_bar_mark_to_market',
    points,
    downsampled_from: n,
    step,
    note: 'Each point is the equity at that bar; buckets keep their LAST bar, plus the global maximum and minimum exactly.',
  };
}
