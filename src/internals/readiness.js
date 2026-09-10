/**
 * Typed readiness predicates.
 *
 * INTERNAL — see paths.js. Re-verify after every TradingView update.
 *
 * This module exists because two objects on the same chart expose a method
 * called `status()` whose numeric values overlap and whose meanings are
 * opposed:
 *
 *   study   2 = ready   3 = error
 *   series  2 = loading 3 = ready
 *
 * Raw status values therefore do not leave src/internals/. Callers get
 * predicates that name the object kind they apply to, and every predicate
 * refuses a row of the wrong kind. Reading a series row with a study predicate
 * is a thrown error, not a plausible answer.
 *
 * The same treatment applies to error reporting. `errorMessage()` returns null
 * on a study that is definitively errored, while `status().errorDescription`
 * carries the reason — so the obvious simplification (read errorMessage, drop
 * the rest) silently discards every error there is. `errorMessage()` is not
 * collected by the snapshot at all, and studyErrorReason is the only accessor.
 */
import { __STATUS_ENUMS_INTERNAL_ONLY } from './paths.js';

const { STUDY_STATUS } = __STATUS_ENUMS_INTERNAL_ONLY;

/** Row kinds. Every snapshot row carries one. */
export const KIND = { STUDY: 'study', SERIES: 'series' };

function requireKind(row, kind, fn) {
  if (!row || typeof row !== 'object') {
    throw new TypeError(`${fn}: expected a ${kind} state row, got ${row === null ? 'null' : typeof row}`);
  }
  if (row.kind !== kind) {
    throw new TypeError(
      `${fn}: expected a '${kind}' row but got '${row.kind ?? 'untagged'}'. ` +
        'Study and series status values overlap numerically and mean opposite ' +
        'things; applying one to the other yields a confident wrong answer. ' +
        'See internals/readiness.js.',
    );
  }
  return row;
}

// --- Studies -------------------------------------------------------------

/**
 * Computed: ready, not loading, and actually holding bars.
 *
 * dataLength is part of the test because status 2 alone is reached before the
 * study has data — measured 2026-09-10, the data source claimed ready while
 * the study-api object held dataLength 0.
 */
export function isStudyReady(row) {
  requireKind(row, KIND.STUDY, 'isStudyReady');
  return (
    row.status_type === STUDY_STATUS.READY &&
    row.is_loading === false &&
    (row.data_length || 0) > 0
  );
}

/** Actively recomputing. Carries loading_since_ms. */
export function isStudyLoading(row) {
  requireKind(row, KIND.STUDY, 'isStudyLoading');
  return row.status_type === STUDY_STATUS.LOADING;
}

/**
 * Terminal. A study with hasError() never reaches READY, so a barrier without
 * this check hangs forever on the commonest development case.
 *
 * status_type ERROR is accepted as well as has_error: they agreed in the one
 * observed failure, and requiring both would make the barrier depend on the
 * weaker of two signals.
 */
export function isStudyErrored(row) {
  requireKind(row, KIND.STUDY, 'isStudyErrored');
  return row.has_error === true || row.status_type === STUDY_STATUS.ERROR;
}

/**
 * Why a study is errored, or null.
 *
 * Reads status().errorDescription, captured by the snapshot. Do not replace
 * this with errorMessage(): measured 2026-09-10 it returned null on every
 * study of a chart that had definitively failed to resolve its data.
 */
export function studyErrorReason(row) {
  requireKind(row, KIND.STUDY, 'studyErrorReason');
  if (!isStudyErrored(row)) return null;
  const d = row.error_description;
  if (!d) return { error: null, title: null, kind: 'unknown' };
  return {
    error: d.error ?? null,
    title: d.title ?? null,
    // A resolve error is a data/symbol failure. Sending the caller to
    // pine_get_errors for one wastes their time.
    kind: d.error === 'resolve error' ? 'data' : 'script',
  };
}

// --- Price series --------------------------------------------------------

/**
 * Terminal series faults. Both are null on a healthy chart.
 *
 * unsupported_resolution is the dangerous one: the chart loads forever while
 * looking entirely normal, so it must be reported as an error and never as
 * slowness.
 */
export function isSeriesErrored(row) {
  requireKind(row, KIND.SERIES, 'isSeriesErrored');
  return !!(row.unsupported_resolution || row.error);
}

export function seriesErrorReason(row) {
  requireKind(row, KIND.SERIES, 'seriesErrorReason');
  if (row.unsupported_resolution) {
    return {
      kind: 'unsupported_resolution',
      message:
        'The data feed does not support the requested resolution for this symbol. The chart will never finish loading it.',
    };
  }
  if (row.error) return { kind: 'series_error', message: `Price series error: ${row.error}` };
  return null;
}

/**
 * Has the series finished a rebuild that started AFTER the given fence?
 *
 * There is deliberately no instantaneous isSeriesReady(). Measured 2026-09-10,
 * every instantaneous signal — isLoading(), status(), bars().size() — reads
 * exactly as it does when settled for the first ~525ms after a mutation, while
 * still holding the previous resolution's bars. A predicate over those values
 * cannot distinguish "not started" from "finished".
 *
 * The event counters can. `completed` must have advanced past what the fence
 * saw, and a teardown (`loading` or `cleared`) must have been counted too, so
 * that a completion belonging to some unrelated refresh cannot satisfy it.
 *
 * With no fence there is nothing to compare against, and this degrades to the
 * weak instantaneous test — correct for a read on a chart nobody just mutated,
 * and explicitly not a guarantee. Callers that mutated must pass a fence.
 */
export function seriesRebuilt(row, since = null) {
  requireKind(row, KIND.SERIES, 'seriesRebuilt');
  const settledNow = row.is_loading === false && (row.bar_count || 0) > 0;
  const ev = row.events;
  if (!since || !since.events || !ev) return settledNow;
  const priorCompleted = since.events.completed ?? null;
  const priorTeardown = (since.events.loading ?? 0) + (since.events.cleared ?? 0);
  if (priorCompleted == null || ev.completed == null) return settledNow;
  const teardownNow = (ev.loading || 0) + (ev.cleared || 0);
  return settledNow && ev.completed > priorCompleted && teardownNow > priorTeardown;
}

/** True when the counters are installed and usable as evidence. */
export function seriesEventsAvailable(row) {
  requireKind(row, KIND.SERIES, 'seriesEventsAvailable');
  return !!(row.events && row.events.completed != null);
}

// --- Presentation --------------------------------------------------------

/**
 * A study's state as a word, for diagnostics returned to callers.
 *
 * Diagnostics used to carry the raw status().type. They no longer do: a number
 * that means "ready" on one object and "error" on another is a trap in a log
 * as much as in a predicate.
 */
export function studyStateLabel(row) {
  requireKind(row, KIND.STUDY, 'studyStateLabel');
  if (isStudyErrored(row)) return 'error';
  if (isStudyReady(row)) return 'ready';
  if (isStudyLoading(row)) return 'loading';
  if (row.status_type === STUDY_STATUS.READY) return 'ready_no_data';
  if (row.status_type === STUDY_STATUS.NO_DATA) return 'no_data';
  return 'unknown';
}
