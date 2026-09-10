/**
 * Settled-gated strategy report reader.
 *
 * This is the only sanctioned way to obtain a trade book. It refuses to return
 * a book it cannot prove is current, because the failure it exists to prevent
 * is a plausible-looking book from the previous chart state.
 */
import { evaluate } from './connection.js';
import { awaitSettled, captureReportState, SETTLE } from './settle.js';
import {
  readReportJs,
  normaliseTrade,
  normaliseOrder,
  normaliseEquity,
  normalisePerformance,
  normaliseWindow,
  reconcile,
} from './internals/report.js';

/**
 * How many times to re-read when the report regenerates between the settle
 * latch and the read. A newer report is fine; what is not fine is returning one
 * without noticing, because then `report_gen` in the payload does not describe
 * the book beside it.
 */
const MAX_REREADS = 3;

/**
 * Read the strategy report.
 *
 * @param {object}  opts
 * @param {string}  [opts.entityId]   Target strategy. Omit to take the one with
 *                                    a computed report.
 * @param {object}  [opts.since]      captureReportState() taken before a
 *                                    mutation. Required to prove regeneration;
 *                                    without it the gate falls back to
 *                                    fingerprint stability, which cannot
 *                                    distinguish a stable current report from a
 *                                    stable stale one.
 * @param {object}  [opts.expectWindow]  { from } — assert the report's backtest
 *                                    window actually starts where the caller
 *                                    set it. See "Why a generation bump is not
 *                                    enough" below.
 * @param {boolean} [opts.gate=true]  Set false only for diagnostics.
 * @param {boolean} [opts.includeOrders=false]
 * @param {boolean} [opts.includeEquity=false]
 * @param {number}  [opts.timeoutMs]
 */
export async function readStrategyReport({
  entityId = null,
  since = null,
  expectWindow = null,
  gate = true,
  includeOrders = false,
  includeEquity = false,
  timeoutMs,
} = {}) {
  let settle = null;
  let latchedAt = null;
  let latchedFingerprint = null;

  if (gate) {
    settle = await awaitSettled({
      entityId,
      scope: entityId ? 'target' : 'strategies',
      requireReport: true,
      since,
      ...(timeoutMs && { timeoutMs }),
    });
    if (settle.outcome !== SETTLE.SETTLED) {
      return {
        ok: false,
        reason: settle.outcome,
        error: settle.error,
        settle,
      };
    }
    latchedAt = Date.now();
    const latched = (settle.studies || []).find(
      (s) => s.is_strategy && (!entityId || s.id === entityId),
    );
    latchedFingerprint = latched?.report_fingerprint ?? null;
  }

  // --- The read itself.
  //
  // One Runtime.evaluate, one synchronous page-context expression. The page is
  // single-threaded and returnByValue serialises with no interleaved script, so
  // `report`, `report_gen` and `report_fingerprint` in a single result are
  // consistent with each other by construction — the read cannot tear.
  //
  // What the read CANNOT guarantee on its own is that nothing changed between
  // the settle latch and the read: those are two separate round-trips, and on a
  // live seconds chart a new bar can land in the gap. So compare the read's own
  // fingerprint against what the latch saw, and if it moved, read again until
  // it holds still. The payload then describes one report, not a blend of two.
  const idExpr = entityId ? JSON.stringify(entityId) : 'null';
  let raw = await evaluate(readReportJs(idExpr));
  let rereads = 0;
  let movedAfterLatch = false;

  while (
    gate &&
    latchedFingerprint &&
    raw?.report_fingerprint &&
    raw.report_fingerprint !== latchedFingerprint &&
    rereads < MAX_REREADS
  ) {
    movedAfterLatch = true;
    rereads++;
    const confirm = await evaluate(readReportJs(idExpr));
    if (confirm?.report_fingerprint === raw?.report_fingerprint) break;
    raw = confirm;
    latchedFingerprint = null; // chasing the moving target, not the latch
  }

  if (!raw?.found) {
    return {
      ok: false,
      reason: 'no_strategy',
      error:
        'No strategy on the chart. Add one, or check the entity id — ids are per-session and do not survive a study being re-added.',
      strategy_count: raw?.strategy_count ?? 0,
    };
  }
  if (!raw.report || !raw.report.performance) {
    return {
      ok: false,
      reason: 'report_not_computed',
      error:
        'The strategy exists but TradingView has not computed a report for it. It is hidden on the chart, or the Strategy Tester has never been opened for it.',
      entity_id: raw.entity_id,
    };
  }

  const report = raw.report;
  const trades = (report.trades || []).map(normaliseTrade);
  const window = normaliseWindow(report);

  // --- Assert the window, not just the generation.
  //
  // `report_gen > since.gen` proves A regeneration happened. It does not prove it
  // was the one the caller asked for, and it fails open in a specific way: if
  // TradingView restarts, `window.__tvmcp_gen` is gone, the counter reinstalls
  // at 0, and `since.gen[id]` of 0 is cleared trivially by any report that
  // happens to be sitting there. Comparing the window the report actually covers
  // against the window the caller set does not have that failure mode.
  if (expectWindow?.from != null && window.backtest_from !== expectWindow.from) {
    return {
      ok: false,
      reason: 'window_mismatch',
      error: `Report covers a backtest window starting ${window.backtest_from}, but ${expectWindow.from} was requested. The report has not been regenerated for the window that was set.`,
      entity_id: raw.entity_id,
      expected_from: expectWindow.from,
      actual_from: window.backtest_from,
      window,
    };
  }

  return {
    ok: true,
    entity_id: raw.entity_id,
    title: raw.title,
    report_gen: raw.report_gen,
    report_fingerprint: raw.report_fingerprint,
    gated: gate,
    ...(gate && {
      settle_ms: settle.elapsed_ms,
      read_consistency: {
        latch_to_read_ms: Date.now() - latchedAt,
        regenerated_after_latch: movedAfterLatch,
        rereads,
        // Set when the report kept moving through every allowed re-read. The
        // payload is still internally consistent — it is one snapshot — but the
        // chart is churning faster than it can be read.
        ...(rereads >= MAX_REREADS && {
          unstable: true,
          warning:
            'The report regenerated on every re-read. The returned book is a single consistent snapshot, but the chart is recomputing continuously; treat any number derived from it as provisional.',
        }),
      },
    }),
    window,
    performance: normalisePerformance(report),
    reconciliation: reconcile(report, trades),
    trades,
    ...(includeOrders && {
      orders: (report.filledOrders || []).map(normaliseOrder),
    }),
    ...(includeEquity && { equity: normaliseEquity(report, trades) }),
  };
}

/**
 * Convenience wrapper for the mutate-then-read pattern.
 *
 * Captures the report generation counter, runs the mutation, then reads with
 * the gate armed. Any tool that changes the chart and then reports a result
 * should use this rather than sequencing the three steps itself.
 */
export async function mutateThenRead(mutate, readOpts = {}) {
  const since = await captureReportState();
  const mutation = await mutate();
  const result = await readStrategyReport({ ...readOpts, since });
  return { mutation, ...result };
}
