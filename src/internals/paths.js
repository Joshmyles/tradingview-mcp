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
export const STUDY_STATUS = {
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
 * The usable predicate is: isLoading() === false && bars().size() > 0.
 * Terminal errors surface on seriesErrorMessage() and
 * unsupportedResolutionState(), both null when healthy.
 */
export const MAIN_SERIES_ID = '_seriesId';
