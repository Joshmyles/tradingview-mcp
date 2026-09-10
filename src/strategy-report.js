/**
 * Settled-gated strategy report reader.
 *
 * This is the only sanctioned way to obtain a trade book. It refuses to return
 * a book it cannot prove is current, because the failure it exists to prevent
 * is a plausible-looking book from the previous chart state.
 */
import { evaluate, getTargetIdentity } from './connection.js';
import { awaitSettled, captureFence, checkFence, SETTLE } from './settle.js';
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
 * @param {object}  [opts.fence]      captureFence() taken before the mutation.
 *                                    Supersedes `since` (it carries it) and
 *                                    additionally proves the read describes the
 *                                    same page context, the same chart, and the
 *                                    intended input configuration. See
 *                                    checkFence in settle.js.
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
  fence = null,
  expectWindow = null,
  gate = true,
  includeOrders = false,
  includeEquity = false,
  timeoutMs,
} = {}) {
  let settle = null;
  let latchedAt = null;
  let latchedFingerprint = null;

  // A fence carries the pre-mutation report state, so a caller that has one
  // never needs to pass `since` as well — but ONLY when the fence declares
  // that a rebuild is owed. A fence taken as a drift baseline must not turn
  // into a demand for a regeneration nobody triggered.
  const effectiveSince = fence
    ? fence.expect_report_rebuild
      ? fence.report
      : null
    : since;

  // --- Fail fast on an input write that did not land.
  //
  // Waiting out the full settle timeout to discover the inputs never changed
  // wastes ninety seconds on a question answerable in one round trip, and the
  // timeout reports the wrong cause. TradingView's own input read has been
  // seen returning stale values, so this failure is not hypothetical.
  if (fence?.expect_inputs_change) {
    const probe = await evaluate(readReportJs(entityId ? JSON.stringify(entityId) : 'null'));
    const prior = fence.strategies?.[probe?.entity_id]?.inputs_hash ?? null;
    if (probe?.found && prior != null && probe.inputs_hash === prior) {
      return {
        ok: false,
        reason: 'fence_violation',
        error:
          'The strategy inputs are unchanged from before the write, so no new report is coming and the current one describes the OLD settings. The input write did not land.',
        violation: { code: 'inputs_not_applied', inputs_hash: probe.inputs_hash },
        entity_id: probe.entity_id,
      };
    }
  }

  if (gate) {
    settle = await awaitSettled({
      entityId,
      scope: entityId ? 'target' : 'strategies',
      requireReport: true,
      since: effectiveSince,
      ...(fence && {
        expectSeriesRebuild:
          fence.expect_series_rebuild === true && fence.expect_report_rebuild === true,
      }),
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

  // --- Assert the state fence.
  //
  // The generation gate proves A rebuild happened. This proves it happened on
  // the chart the caller mutated, for the configuration the caller set. The
  // two fail apart: a rebuild triggered by a passing bar clears the first and
  // not the second, and a read taken from a hidden preview context clears both
  // gates while describing a different chart entirely.
  const fenceViolation = checkFence(fence, {
    target_id: getTargetIdentity()?.target_id ?? null,
    symbol: raw.symbol ?? null,
    resolution: raw.resolution ?? null,
    entity_id: raw.entity_id,
    inputs_hash: raw.inputs_hash ?? null,
  });
  if (fenceViolation) {
    return {
      ok: false,
      reason: 'fence_violation',
      error: fenceViolation.message,
      violation: fenceViolation,
      entity_id: raw.entity_id,
      window,
    };
  }

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
    inputs_hash: raw.inputs_hash ?? null,
    gated: gate,
    ...(fence && {
      fence_check: {
        passed: true,
        target_id: getTargetIdentity()?.target_id ?? null,
        expect_series_rebuild: fence.expect_series_rebuild === true,
        expect_inputs_change: fence.expect_inputs_change === true,
        // Reported, never asserted: on a seconds chart the backtest window is
        // a rolling cap that slides as bars arrive, so a moved `from` is
        // normal. expectWindow is the exact check when one was actually set.
        window_moved:
          fence.strategies?.[raw.entity_id]?.backtest_from != null &&
          fence.strategies[raw.entity_id].backtest_from !== window.backtest_from
            ? {
                from: fence.strategies[raw.entity_id].backtest_from,
                to: window.backtest_from,
              }
            : null,
      },
    }),
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
 * Captures a state fence, runs the mutation, then reads with the gate armed.
 * Any tool that changes the chart and then reports a result should use this
 * rather than sequencing the three steps itself.
 *
 * `fenceOpts` declares what the mutation is allowed to change:
 * { seriesAffecting } for a symbol or resolution change, { inputsAffecting }
 * for an input write. Declaring nothing means the mutation must leave the
 * chart identity and the strategy configuration alone, and the read fails if
 * either moved.
 */
export async function mutateThenRead(mutate, readOpts = {}, fenceOpts = {}) {
  // A mutation is being run, so a rebuild is owed by default.
  const fence = await captureFence({ reportAffecting: true, ...fenceOpts });
  const mutation = await mutate();
  const result = await readStrategyReport({ ...readOpts, fence });
  return { mutation, ...result };
}
