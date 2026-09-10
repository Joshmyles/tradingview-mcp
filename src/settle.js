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
import { evaluate } from './connection.js';
import { studyStateJs, INSTALL_GEN_COUNTER_JS } from './internals/study-state.js';
import { STUDY_STATUS, PATHS } from './internals/paths.js';

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

/** A study is computed when it is ready, not loading, and actually holds bars. */
function isComputed(s) {
  return (
    s.type === STUDY_STATUS.READY && s.is_loading === false && (s.data_length || 0) > 0
  );
}

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
 * Returns { gen, fp } — the generation counters AND the current fingerprints.
 * Both are needed: measured 2026-09-10, reportChanged() fired three times with
 * byte-identical content, so a generation bump on its own does not prove a new
 * book. See awaitSettled's teardown check.
 *
 * Installs the counters if they are not present. Safe to call repeatedly.
 */
export async function captureReportState() {
  try {
    const r = await evaluate(INSTALL_GEN_COUNTER_JS);
    return { gen: r?.gen || {}, fp: r?.fp || {} };
  } catch {
    // Counter unavailable (page reloaded, internals moved). awaitSettled falls
    // back to fingerprint stability, which is weaker but not wrong.
    return { gen: {}, fp: {} };
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
      const seriesFault = series.unsupported_resolution || series.error;
      if (seriesFault) {
        return {
          outcome: SETTLE.ERRORED,
          elapsed_ms: Date.now() - started,
          polls,
          series,
          error: series.unsupported_resolution
            ? 'The data feed does not support the requested resolution for this symbol. The chart will never finish loading it.'
            : `Price series error: ${series.error}`,
          studies,
        };
      }
      if (series.is_loading === false && (series.bar_count || 0) > 0) {
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
    const errored = targets.filter((s) => s.has_error === true);
    if (errored.length) {
      return {
        outcome: SETTLE.ERRORED,
        elapsed_ms: Date.now() - started,
        polls,
        errored_studies: errored.map((s) => ({
          id: s.id,
          title: s.title,
          type: s.type,
          ...(s.error_description && { detail: s.error_description }),
        })),
        error:
          // A resolve error is a data problem, not a script problem, and sending
          // the caller to pine_get_errors for one wastes their time.
          errored.some((s) => s.error_description?.error === 'resolve error')
            ? 'The chart failed to resolve its data ("resolve error"). This is a data/symbol failure, not a script error — the studies will never compute until the chart re-resolves. Check the symbol is valid and the connection is live.'
            : 'Study has a compile or runtime error and will never finish computing. Read pine_get_errors.',
        studies,
      };
    }

    for (const s of targets) {
      if (isComputed(s)) computedOnce.add(s.id);
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
        ...(requireSeries && { series }),
        studies,
      };
    }

    // --- Terminal: a recompute that has been running far too long. Distinct
    // from a timeout: the study is demonstrably stuck, not merely slow.
    const stuck = targets.filter(
      (s) =>
        !computedOnce.has(s.id) &&
        s.type === STUDY_STATUS.LOADING &&
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
          type: s.type,
          data_length: s.data_length,
        })),
        ...(staleReports.length && { reports_not_regenerated: staleReports }),
        ...(requireSeries && !seriesComputedOnce && { series_not_ready: series }),
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
export async function captureFence() {
  const report = await captureReportState();
  let chart = {};
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
  return {
    symbol: chart?.symbol ?? null,
    resolution: chart?.resolution ?? null,
    report,
    at: Date.now(),
  };
}

/**
 * Gate a read. Returns { ok: true, settle } or a ready-to-return error object.
 *
 * Reads of computed data call this; mutations do not. The hazard being defended
 * against is a read that describes the previous chart state, and that hazard
 * exists at the moment of reading, not at the moment of mutating.
 */
export async function requireSettled(opts = {}) {
  const settle = await awaitSettled(opts);
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
