/**
 * The recompute barrier.
 *
 * Every mutating tool must await this before returning. Without it,
 * `chart_ready: true` is a lie: measured on this machine, chart_set_timeframe
 * returned success at ~3s while the strategy did not finish recomputing until
 * 21.3s, 28.4s and 19.2s across three measured 45S->30S changes. Reads issued in that window hit a
 * study holding dataLength 0, or — worse — a strategy report still describing
 * the PREVIOUS chart state.
 *
 * Outcomes are deliberately not booleans. A caller must be able to tell
 * "still loading" from "will never load".
 */
import { evaluate, getTargetIdentity } from './connection.js';
import { studyStateJs, INSTALL_GEN_COUNTER_JS } from './internals/study-state.js';
import { PATHS } from './internals/paths.js';
import {
  isStudyReady,
  isStudyLoading,
  isStudyErrored,
  studyErrorReason,
  studyStateLabel,
  isSeriesErrored,
  seriesErrorReason,
  seriesRebuilt,
} from './internals/readiness.js';

/** Measured worst case on this hardware was 28.4s for a 45S->30S change. */
export const DEFAULT_TIMEOUT_MS = Number(process.env.TV_SETTLE_TIMEOUT_MS) || 90000;
/** A recompute still running after this long is reported as stuck, not pending. */
export const DEFAULT_STUCK_MS = Number(process.env.TV_SETTLE_STUCK_MS) || 60000;
const POLL_MS = Number(process.env.TV_SETTLE_POLL_MS) || 250;

export const SETTLE = {
  SETTLED: 'settled',
  TIMED_OUT: 'timed_out',
  ERRORED: 'errored',
  STUCK: 'stuck',
  ABSENT: 'absent',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Which studies this call is allowed to block on.
 *
 * Housekeeping sources are always excluded: they never resolve (see paths.js).
 * Under 'all', invisible studies are excluded too — a chart accumulates
 * switched-off overlays that sit at status 0 forever, and waiting on those is
 * indistinguishable from waiting on a study that is genuinely about to compute.
 * Measured 2026-09-10: of 20 data sources on the working chart, 4 were
 * permanently-loading housekeeping and 11 were switched-off overlays.
 */
function selectTargets(studies, scope, entityId) {
  const live = studies.filter((s) => !s.housekeeping);
  if (scope === 'target') return live.filter((s) => s.id === entityId);
  if (scope === 'all') return live.filter((s) => s.is_visible !== false);
  return live.filter((s) => s.is_strategy);
}

/**
 * Snapshot per-strategy report state BEFORE a mutation, so awaitSettled can
 * require that the report was genuinely rebuilt rather than accepting the stale
 * one that outlives the mutation that invalidated it.
 *
 * Returns { gen, fp, events }:
 *   gen     per-strategy report generation counters
 *   fp      per-strategy report fingerprints
 *   events  price-series rebuild edge counts
 *
 * gen and fp are both needed: measured 2026-09-10, reportChanged() fired three
 * times with byte-identical content, so a generation bump on its own does not
 * prove a new book. See awaitSettled's teardown check.
 *
 * events covers the price series, which has no usable instantaneous readiness
 * signal at all — every one of them reads "settled" for the first ~525ms after
 * a mutation while still holding the previous resolution's bars.
 *
 * Installs the counters if they are not present. Safe to call repeatedly.
 */
export async function captureReportState() {
  try {
    const r = await evaluate(INSTALL_GEN_COUNTER_JS);
    return { gen: r?.gen || {}, fp: r?.fp || {}, events: r?.events || null };
  } catch {
    // Counter unavailable (page reloaded, internals moved). awaitSettled falls
    // back to fingerprint stability, which is weaker but not wrong.
    return { gen: {}, fp: {}, events: null };
  }
}

/**
 * Wait until the chart's studies have finished recomputing.
 *
 * @param {object}  opts
 * @param {string}  [opts.entityId]       Study to gate on, with scope 'target'.
 * @param {string}  [opts.scope]          'target' | 'strategies' | 'all'.
 *                                        'strategies' (the default without an
 *                                        entityId) gates on every strategy
 *                                        source. 'all' additionally gates on
 *                                        every visible user study, which is
 *                                        what a recipe reading across studies
 *                                        needs. Housekeeping sources are never
 *                                        gated on — see paths.js.
 * @param {boolean} [opts.requireReport]  Also gate on the strategy report.
 * @param {boolean} [opts.requireSeries]  Also gate on the main price series.
 *                                        Reads of bars need this; the study
 *                                        scopes cannot see the series at all
 *                                        (see paths.js).
 * @param {object}  [opts.since]          Result of captureReportState(), taken
 *                                        before the mutation. Supplying it
 *                                        upgrades the report gate from "stable"
 *                                        to "demonstrably rebuilt".
 * @param {boolean} [opts.expectSeriesRebuild]
 *                                        Whether the mutation could have
 *                                        rebuilt the PRICE SERIES, as a symbol
 *                                        or resolution change does. Only then
 *                                        is `since.events` treated as a
 *                                        requirement. Unhiding a study bumps
 *                                        the report and leaves the series
 *                                        untouched, so demanding series edge
 *                                        evidence for one waits for something
 *                                        that is never coming. A fence proves
 *                                        a rebuild happened; it cannot say a
 *                                        rebuild was due.
 * @param {number}  [opts.timeoutMs]
 * @param {number}  [opts.stuckMs]
 * @param {number}  [opts.stableReads]    Consecutive identical report
 *                                        fingerprints required. Default 2.
 * @returns {Promise<object>} { outcome, elapsed_ms, polls, studies, ... }
 */
export async function awaitSettled({
  entityId = null,
  scope = entityId ? 'target' : 'strategies',
  requireReport = false,
  requireSeries = false,
  since = null,
  expectSeriesRebuild = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  stuckMs = DEFAULT_STUCK_MS,
  stableReads = 2,
} = {}) {
  const started = Date.now();
  const idExpr = entityId ? JSON.stringify(entityId) : 'null';
  // Gate on one study or on every study, per scope. 'target' still snapshots
  // the whole chart so the returned state is useful when it times out.
  const js = studyStateJs(scope === 'target' ? idExpr : 'null');

  // Latches: a live seconds chart flips a settled study back to type 1 on every
  // new bar (measured 2026-09-10: the study reached type 2 with dataLength 435
  // at t=19.2s and was back at type 1 with dataLength 0 by t=20.4s). Requiring
  // "computed right now" would therefore never return on a live seconds chart.
  // Once observed computed, a study stays settled for this call.
  const computedOnce = new Set();
  const reportOnce = new Map(); // id -> { fingerprint, stable }
  // Positive evidence that the PREVIOUS book was torn down: either the report
  // went absent during the recompute, or its fingerprint moved off the one
  // captured before the mutation. Without this a no-op reportChanged() refire
  // (measured: three fires, identical content) would clear the generation check
  // while the stale book was still sitting there.
  const teardownSeen = new Set();
  let seriesComputedOnce = false;

  let polls = 0;
  let last = null;

  for (;;) {
    let snap;
    try {
      snap = await evaluate(js);
    } catch (err) {
      return {
        outcome: SETTLE.ERRORED,
        elapsed_ms: Date.now() - started,
        polls,
        error: `study state read failed: ${err.message}`,
        studies: last?.studies || [],
      };
    }
    polls++;
    last = snap;

    const studies = snap?.studies || [];
    const series = snap?.series || null;
    const targets = selectTargets(studies, scope, entityId);

    // --- Terminal: the feed cannot serve what was asked for. A resolution the
    // data provider does not support leaves the chart loading indefinitely
    // while looking perfectly normal, so it must not be reported as slowness.
    if (requireSeries && series) {
      if (isSeriesErrored(series)) {
        const reason = seriesErrorReason(series);
        return {
          outcome: SETTLE.ERRORED,
          elapsed_ms: Date.now() - started,
          polls,
          series,
          error: reason.message,
          error_kind: reason.kind,
          studies,
        };
      }
      // seriesRebuilt is only conclusive with a `since`, and a `since` is only
      // meaningful when the mutation could have rebuilt the series. Without
      // both it falls back to the instantaneous test, which is documented as
      // weak rather than silently trusted — see readiness.js.
      if (seriesRebuilt(series, expectSeriesRebuild ? since : null)) {
        seriesComputedOnce = true;
      }
    }

    // With requireSeries, an empty study set is legitimate: a bars-only read on
    // a chart carrying no studies has something real to wait for. An explicitly
    // named entity that is not there is still absent, series or no series.
    if (targets.length === 0 && (entityId || !requireSeries)) {
      return {
        outcome: SETTLE.ABSENT,
        elapsed_ms: Date.now() - started,
        polls,
        scope,
        entity_id: entityId,
        error: entityId
          ? `No study ${entityId} on the chart. Entity ids do not survive a study being removed and re-added; resolve by name instead.`
          : `Nothing to wait for under scope '${scope}'.`,
        studies,
      };
    }

    // --- Terminal: compile error. A study with hasError() never reaches type 2,
    // so without this the barrier hangs forever on the commonest dev case.
    const errored = targets.filter(isStudyErrored);
    if (errored.length) {
      const reasons = errored.map(studyErrorReason);
      return {
        outcome: SETTLE.ERRORED,
        elapsed_ms: Date.now() - started,
        polls,
        errored_studies: errored.map((s, i) => ({
          id: s.id,
          title: s.title,
          state: studyStateLabel(s),
          ...(reasons[i] && { detail: reasons[i] }),
        })),
        error:
          // A resolve error is a data problem, not a script problem, and sending
          // the caller to pine_get_errors for one wastes their time.
          reasons.some((r) => r?.kind === 'data')
            ? 'The chart failed to resolve its data ("resolve error"). This is a data/symbol failure, not a script error — the studies will never compute until the chart re-resolves. Check the symbol is valid and the connection is live.'
            : 'Study has a compile or runtime error and will never finish computing. Read pine_get_errors.',
        studies,
      };
    }

    for (const s of targets) {
      if (isStudyReady(s)) computedOnce.add(s.id);
      if (requireReport && s.is_strategy) {
        const priorFp = since?.fp?.[s.id];
        if (
          !s.report_present ||
          (priorFp != null && s.report_fingerprint !== priorFp)
        ) {
          teardownSeen.add(s.id);
        }
        const priorGen = since?.gen?.[s.id];
        const genOk =
          !since ||
          priorGen == null ||
          s.report_gen == null ||
          (s.report_gen > priorGen && teardownSeen.has(s.id));
        if (s.report_present && s.report_fingerprint && genOk) {
          const prev = reportOnce.get(s.id);
          if (prev && prev.fingerprint === s.report_fingerprint) {
            reportOnce.set(s.id, {
              fingerprint: s.report_fingerprint,
              stable: prev.stable + 1,
            });
          } else {
            reportOnce.set(s.id, { fingerprint: s.report_fingerprint, stable: 1 });
          }
        } else {
          // Stale, absent, or not yet regenerated — reset, do not accumulate.
          reportOnce.delete(s.id);
        }
      }
    }

    const allComputed = targets.every((s) => computedOnce.has(s.id));
    const seriesReady = !requireSeries || seriesComputedOnce;
    const reportsReady =
      !requireReport ||
      targets
        .filter((s) => s.is_strategy)
        .every((s) => (reportOnce.get(s.id)?.stable || 0) >= stableReads);

    if (allComputed && reportsReady && seriesReady) {
      return {
        outcome: SETTLE.SETTLED,
        elapsed_ms: Date.now() - started,
        polls,
        scope,
        entity_id: entityId,
        report_gated: requireReport,
        series_gated: requireSeries,
        ...(requireSeries && {
          // 'proven' means an observed teardown-then-completion edge pair.
          // 'assumed' means nothing was expected to change and the series was
          // simply found loaded — correct for a read on a quiet chart, and not
          // a guarantee that a pending rebuild has finished.
          series_evidence:
            expectSeriesRebuild && since?.events ? 'proven' : 'assumed',
        }),
        ...(requireSeries && { series }),
        studies,
      };
    }

    // --- Terminal: a recompute that has been running far too long. Distinct
    // from a timeout: the study is demonstrably stuck, not merely slow.
    const stuck = targets.filter(
      (s) =>
        !computedOnce.has(s.id) &&
        isStudyLoading(s) &&
        (s.loading_since_ms || 0) > stuckMs,
    );
    if (stuck.length) {
      return {
        outcome: SETTLE.STUCK,
        elapsed_ms: Date.now() - started,
        polls,
        stuck_studies: stuck.map((s) => ({
          id: s.id,
          title: s.title,
          loading_since_ms: s.loading_since_ms,
        })),
        error: `Study recompute has been running for over ${stuckMs}ms. This is not slowness; the chart needs attention.`,
        studies,
      };
    }

    if (Date.now() - started >= timeoutMs) {
      const pending = targets.filter((s) => !computedOnce.has(s.id));
      const staleReports = requireReport
        ? targets
            .filter(
              (s) => s.is_strategy && (reportOnce.get(s.id)?.stable || 0) < stableReads,
            )
            .map((s) => ({
              id: s.id,
              report_present: s.report_present,
              report_gen: s.report_gen,
              prior_gen: since?.gen?.[s.id] ?? null,
              teardown_observed: teardownSeen.has(s.id),
            }))
        : [];
      return {
        outcome: SETTLE.TIMED_OUT,
        elapsed_ms: Date.now() - started,
        polls,
        timeout_ms: timeoutMs,
        pending_studies: pending.map((s) => ({
          id: s.id,
          title: s.title,
          state: studyStateLabel(s),
          data_length: s.data_length,
        })),
        ...(staleReports.length && { reports_not_regenerated: staleReports }),
        ...(requireSeries &&
          !seriesComputedOnce && {
            series_not_ready: {
              ...series,
              expected_series_rebuild: expectSeriesRebuild,
              ...(expectSeriesRebuild &&
                since?.events && {
                  prior_events: since.events,
                  note: 'The series gate was armed with a fence and no rebuild edge arrived. Either the mutation did not touch the price series, or it has not started.',
                }),
            },
          }),
        error: `Timed out after ${timeoutMs}ms. Studies are still computing — any read taken now describes the previous chart state. Raise TV_SETTLE_TIMEOUT_MS or retry.`,
        studies,
      };
    }

    await sleep(POLL_MS);
  }
}

/** True only for the one outcome that means the chart can be trusted. */
export const isSettled = (r) => r?.outcome === SETTLE.SETTLED;

/**
 * Capture the chart state a later read can be checked against.
 *
 * A mutation returns this instead of asserting a readiness it has not verified.
 * The caller hands it back to the read, which can then prove the report was
 * rebuilt (report.gen / report.fp) rather than merely being present.
 *
 * This is the minimal fence: symbol, resolution, and report identity. The full
 * fence — input hash included — is a later stage; the components here are the
 * ones already known to be sound. `backtest.to` is deliberately not among them:
 * it is the live chart edge and advances on every bar, so it can never be part
 * of an identity.
 */
export async function captureFence({
  seriesAffecting = false,
  inputsAffecting = false,
  reportAffecting = false,
} = {}) {
  const report = await captureReportState();
  let chart = {};
  let strategies = {};
  try {
    chart = await evaluate(`
      (function() {
        var cw = ${PATHS.chartApi};
        return {
          symbol: (function () { try { return cw.symbol(); } catch (e) { return null; } })(),
          resolution: (function () { try { return cw.resolution(); } catch (e) { return null; } })()
        };
      })()`);
  } catch {
    chart = {};
  }
  try {
    const snap = await evaluate(studyStateJs('null'));
    for (const st of snap?.studies || []) {
      if (!st.is_strategy) continue;
      strategies[st.id] = {
        inputs_hash: st.inputs_hash ?? null,
        backtest_from: st.backtest_from ?? null,
      };
    }
  } catch {
    strategies = {};
  }
  return {
    symbol: chart?.symbol ?? null,
    resolution: chart?.resolution ?? null,
    report,
    strategies,
    // Carried on the fence so a caller handing it back gets the right gate
    // without having to remember what kind of mutation produced it.
    expect_series_rebuild: seriesAffecting,
    expect_inputs_change: inputsAffecting,
    // Whether a REGENERATION is owed at all.
    //
    // A fence has two jobs that were initially conflated: proving a rebuild
    // happened, and detecting drift that should not have happened. Only the
    // first needs a mutation. A fence taken purely as a drift baseline that
    // demanded a regeneration would wait forever for one nobody triggered —
    // measured: a clean read timed out at 90s against an untouched chart.
    expect_report_rebuild: reportAffecting || seriesAffecting || inputsAffecting,
    target: getTargetIdentity(),
    at: Date.now(),
  };
}

/**
 * Check a read against the fence taken before the mutation.
 *
 * The generation gate answers "was the report rebuilt". This answers the
 * separate question "was it rebuilt for the state I set, on the chart I set it
 * on". They fail differently: a rebuild triggered by a passing bar satisfies
 * the first and not the second.
 *
 * Returns null when the read is consistent with the fence, otherwise
 * { code, message, ...evidence }.
 *
 * Declaring nothing means the mutation must leave the chart identity and the
 * strategy configuration alone: the fence then asserts stability and requires
 * no rebuild.
 *
 * `backtest_from` is deliberately NOT a hard check. On a seconds chart the
 * backtest window is a rolling cap that slides as bars arrive, so equality
 * would fail on a chart that had done nothing wrong. A caller that genuinely
 * set a window asserts it with expectWindow, which is exact.
 */
export function checkFence(fence, observed) {
  if (!fence) return null;

  const fenceTarget = fence.target?.target_id ?? null;
  if (fenceTarget && observed.target_id && fenceTarget !== observed.target_id) {
    return {
      code: 'target_changed',
      message:
        'This read came from a different TradingView page context than the mutation was applied to. TradingView Desktop runs hidden preview renderers alongside the real chart, each with its own symbol and studies, so the two are not comparable. See internals/targets.js.',
      fence_target: fenceTarget,
      observed_target: observed.target_id,
    };
  }

  if (!fence.expect_series_rebuild) {
    if (fence.symbol && observed.symbol && fence.symbol !== observed.symbol) {
      return {
        code: 'chart_drifted',
        message: `The chart symbol changed from ${fence.symbol} to ${observed.symbol} between the mutation and this read. Something else moved the chart.`,
        fence_symbol: fence.symbol,
        observed_symbol: observed.symbol,
      };
    }
    if (
      fence.resolution &&
      observed.resolution &&
      fence.resolution !== observed.resolution
    ) {
      return {
        code: 'chart_drifted',
        message: `The chart resolution changed from ${fence.resolution} to ${observed.resolution} between the mutation and this read. Something else moved the chart.`,
        fence_resolution: fence.resolution,
        observed_resolution: observed.resolution,
      };
    }
  }

  const priorInputs = fence.strategies?.[observed.entity_id]?.inputs_hash ?? null;
  const nowInputs = observed.inputs_hash ?? null;
  if (priorInputs != null && nowInputs != null) {
    if (fence.expect_inputs_change && priorInputs === nowInputs) {
      return {
        code: 'inputs_not_applied',
        message:
          'The strategy inputs are unchanged from before the write, so the report describes the OLD settings. The input write did not land.',
        inputs_hash: nowInputs,
      };
    }
    if (!fence.expect_inputs_change && priorInputs !== nowInputs) {
      return {
        code: 'inputs_drifted',
        message:
          'The strategy inputs changed between the mutation and this read. The report does not describe the configuration that was fenced.',
        fence_inputs_hash: priorInputs,
        observed_inputs_hash: nowInputs,
      };
    }
  }

  return null;
}

/**
 * Gate a read. Returns { ok: true, settle } or a ready-to-return error object.
 *
 * Reads of computed data call this; mutations do not. The hazard being defended
 * against is a read that describes the previous chart state, and that hazard
 * exists at the moment of reading, not at the moment of mutating.
 *
 * Pass `fence` (from captureFence) to upgrade the gate from "the chart looks
 * settled" to "the chart was demonstrably rebuilt since that fence". The fence
 * carries its own knowledge of whether a series rebuild was due.
 */
export async function requireSettled(opts = {}) {
  const { fence, ...rest } = opts;
  const settle = await awaitSettled(
    fence
      ? {
          ...rest,
          since: fence.report,
          expectSeriesRebuild: fence.expect_series_rebuild === true,
        }
      : rest,
  );
  if (settle.outcome === SETTLE.SETTLED) return { ok: true, settle };
  return {
    ok: false,
    success: false,
    reason: settle.outcome,
    error: settle.error,
    settle: {
      outcome: settle.outcome,
      elapsed_ms: settle.elapsed_ms,
      ...(settle.errored_studies && { errored_studies: settle.errored_studies }),
      ...(settle.pending_studies && { pending_studies: settle.pending_studies }),
      ...(settle.stuck_studies && { stuck_studies: settle.stuck_studies }),
      ...(settle.series_not_ready && { series_not_ready: settle.series_not_ready }),
    },
  };
}
