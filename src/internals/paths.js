/**
 * TradingView internal object paths and DOM selectors.
 *
 * Everything in this directory is an INTERNAL: an undocumented path into the
 * TradingView application's own runtime. None of it is a public API. It is
 * pinned to a specific TradingView Desktop build and must be re-verified after
 * every TradingView update via the internals_verify tool.
 *
 * Rule: no file outside src/internals/ may contain a `window.TradingViewApi...`
 * path, a CSS class selector, an aria-label, or a data-name attribute.
 */

/** TradingView Desktop build these internals were verified against. */
export const VERIFIED_AGAINST = {
  tv_desktop: '3.4.1.8194',
  electron: '41.7.1',
  chrome: '146.0.7680.216',
  verified_on: '2026-09-10',
};

/**
 * Root object paths.
 *
 * chartWidgetValue  → the ChartWidget "value" wrapper. Exposes getStudyById().
 * chartWidget       → the inner widget. Exposes model() and the data sources.
 * dataSources       → array of every source on the chart (series, studies,
 *                     strategies). A strategy is a source exposing reportData().
 */
export const PATHS = {
  chartApi: 'window.TradingViewApi._activeChartWidgetWV.value()',
  chartWidget: 'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget',
  dataSources:
    'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().model().dataSources()',
  mainSeries:
    'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries()',
  replayApi: 'window.TradingViewApi._replayApi',
  alertService: 'window.TradingViewApi._alertService',
  bottomWidgetBar: 'window.TradingView.bottomWidgetBar',
};

/**
 * Two DIFFERENT objects represent the same study, and they disagree.
 *
 *   study-api object   chartApi.getStudyById(id)
 *                      → dataLength(), hasError(), status(), title(),
 *                        getInputsInfo(), getInputValues(), setInputValues()
 *
 *   data source        dataSources().find(s => s.id() === id)
 *                      → reportData(), ordersData(), reportChanged(),
 *                        performance(), metaInfo()
 *
 * Measured 2026-09-10 on a live 45S chart: the data source reported
 * status().type === 2 / isLoading() === false at the same instant the
 * study-api object reported status().type === 1 / dataLength() === 0.
 *
 * The study-api object is the one that tracks recompute. Readiness predicates
 * MUST use it. The data source is only for report access.
 */
export const STUDY_OBJECTS = {
  apiById: (idExpr) => `${PATHS.chartApi}.getStudyById(${idExpr})`,
};

/**
 * Study status().type enum — established empirically, not documented.
 *   0  no data / inactive
 *   1  loading or recomputing (carries startTime, epoch ms)
 *   2  ready
 */
const STUDY_STATUS = {
  NO_DATA: 0,
  LOADING: 1,
  READY: 2,
  /* Observed 2026-09-10 after a data-resolution failure: every study on the
     chart, housekeeping included, sat at type 3 with
     status().errorDescription = { error: 'resolve error', title: 'Runtime
     error' } and hasError() === true. A study at 3 will never reach 2, so any
     predicate that waits for READY without a terminal error check hangs on it
     forever. hasError() is the reliable signal; errorDescription carries the
     reason worth reporting. */
  ERROR: 3,
};

/**
 * Series status() enum — a DIFFERENT enum on a DIFFERENT object.
 *
 * Measured 2026-09-10 across resolution changes: 2 while loading, 3 when ready.
 * A study reads 2 for ready and 3 for error. Same method name, inverted
 * meaning, on two objects that sit side by side in dataSources().
 *
 * Observational only. Nothing predicates on it, because it fails open: it
 * reads 3 before a mutation has torn the series down as well as after the
 * rebuild finished. See readiness.js.
 */
const SERIES_STATUS = {
  LOADING: 2,
  READY: 3,
};

/**
 * Neither enum is exported from this directory.
 *
 * They are numerically overlapping and semantically opposed, so any code
 * holding both can silently apply the wrong one. readiness.js exports typed,
 * kind-checked predicates instead; those are the only sanctioned reading of
 * either value. A comment saying "do not mix these up" does not survive a
 * refactor — an unexported constant does.
 */
export const __STATUS_ENUMS_INTERNAL_ONLY = { STUDY_STATUS, SERIES_STATUS };

/**
 * graphicsViewsReady() returns true WHILE the study is still loading.
 * Measured 2026-09-10. Never use it as a readiness signal.
 */
export const UNUSABLE_SIGNALS = ['graphicsViewsReady', 'anyGraphicsReady'];

/**
 * TradingView installs housekeeping pseudo-studies on every chart:
 * dividends, splits, earnings, roll dates. On an instrument with no corporate
 * actions — XAUUSD, for one — they sit at status().type === 1 (loading) with
 * dataLength 0 permanently and never resolve.
 *
 * Measured 2026-09-10: ESD$TV_DIVIDENDS, ESD$TV_SPLITS, ESD$TV_EARNINGS,
 * ESD$TV_ROLLDATES were all still "loading" on a fully settled chart. A
 * readiness barrier that waits for every data source therefore never returns.
 * Exclude them.
 */
export const HOUSEKEEPING_ID_PREFIX = 'ESD$TV_';
export const isHousekeepingStudy = (id) =>
  typeof id === 'string' && id.startsWith(HOUSEKEEPING_ID_PREFIX);

/**
 * The main price series sits in dataSources() under this id, but
 * `getStudyById('_seriesId')` THROWS — verified 2026-09-10. Any snapshot that
 * enumerates sources and resolves each through getStudyById therefore skips the
 * price series entirely and silently.
 *
 * It also does not share the study readiness vocabulary:
 *   - status() returns 3 on a fully settled chart, where a settled STUDY is 2.
 *     The two enums are unrelated. Do not compare a series status to
 *     STUDY_STATUS.
 *   - dataLength() and hasError() do not exist on it.
 *   - symbolSameAsResolved() is FALSE on a settled chart (it compares the
 *     requested symbol to the resolved one, and "XAUUSD" != "ICMARKETS:XAUUSD").
 *     It reads like a readiness signal and is not one.
 *
 * There is NO usable instantaneous readiness predicate for the series.
 * Measured 2026-09-10 across a 45S->30S change, sampling in-page at 20ms:
 *
 *      0-525ms   isLoading() false, status() 3, bars().size() 310  <- ALL STALE
 *    525ms       dataEvents().loading fires
 *    527ms       dataEvents().cleared fires, bars().size() -> 0
 *    546ms       dataEvents().completed fires, bars().size() -> 300
 *
 * `isLoading() === false && bars().size() > 0` is satisfied throughout the
 * first half-second by the PREVIOUS resolution's book. bars().size() does not
 * climb progressively — it steps stale -> 0 -> final in ~7ms — so a
 * stabilisation check does not close the gap either; it stabilises on the
 * stale value.
 *
 * What closes it is the event bus. See SERIES_EVENTS below.
 *
 * Terminal errors surface on seriesErrorMessage() and
 * unsupportedResolutionState(), both null when healthy. seriesLoaded() is NOT
 * a readiness signal: it is false on a fully settled chart.
 */
export const MAIN_SERIES_ID = '_seriesId';

/**
 * mainSeries().dataEvents() is a subscribable event bus, and it is the only
 * signal that distinguishes "the series has not started reloading yet" from
 * "the series has finished reloading".
 *
 * Verified firing 2026-09-10 on the visible chart, once per resolution change:
 *
 *   modified   the mutation registered
 *   loading    teardown begins
 *   cleared    bars() emptied
 *   completed  new book in place, isLoading() false
 *
 * Counting fires gives the series the same barrier the strategy report has: a
 * generation number plus positive teardown evidence, neither of which a poll
 * can miss.
 *
 * dataUpdated fires continuously on a live chart (43 fires in 22s) and is
 * useless as a settle signal. barReceived is a new-bar tick, not a rebuild.
 *
 * WARNING: an earlier run of this probe recorded ZERO fires for every event.
 * That measurement was taken against a hidden layout preview context, not the
 * chart — see targets.js. Re-verify only against a target that reports
 * document.visibilityState === 'visible'.
 */
export const SERIES_EVENTS = {
  TEARDOWN: ['loading', 'cleared'],
  COMPLETED: 'completed',
  ERROR: ['error', 'seriesError', 'symbolError', 'symbolInvalid'],
  UNSUPPORTED: 'unsupportedResolutionRequested',
  /* Fires on every tick; never gate on these. */
  NOISE: ['dataUpdated', 'barReceived'],
};
