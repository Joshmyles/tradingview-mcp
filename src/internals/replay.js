/**
 * Replay stepping — advancing bar by bar, in the page, against a predicate.
 *
 * INTERNAL — see paths.js. Re-verify after every TradingView update.
 *
 * ## Why the loop runs in the page
 *
 * `replay_step` costs one CDP round trip per bar and polls `currentDate()` at
 * 250ms for up to 3s. Advancing 500 bars that way is minutes of round trips to
 * throw away 499 intermediate states. The whole loop therefore runs inside one
 * awaited page expression and only the STOPPING state comes back.
 *
 * ## currentDate() is in SECONDS
 *
 * Measured 2026-09-11: `currentDate()` returned `1788849356` while the chart
 * was on 2026-09-08. Every other time in this codebase — `trades[].e.tm`,
 * `dateRange.backtest.from`, a deep-backtest window — is epoch MILLISECONDS.
 * A predicate comparing a replay cursor against a millisecond timestamp is off
 * by a factor of a thousand and reads as "never true", which looks exactly
 * like a predicate that simply did not fire. Times are normalised to ms at the
 * boundary and `time` in a predicate is milliseconds like everything else.
 *
 * ## No fixed sleep is safe
 *
 * Ten consecutive steps on the reference chart, measured in-page:
 *
 *   283, 7711, 599, 444, 282, 293, 378, 349, 301, 305 ms
 *
 * The median is ~300ms and one step took 7.7 seconds — a 26x spread inside one
 * run of ten. A sleep tuned to the median drops a quarter of the steps; one
 * tuned to the outlier is 25x slower than it needs to be. The loop waits on
 * the `currentDate()` EDGE instead, polling at 5ms, with a per-step ceiling
 * generous enough for the outlier.
 *
 * This is the same rule as the rest of the bridge: it is an edge, not a level,
 * and the edge is counted from before the mutation.
 *
 * ## Two tiers of observable, and they do not settle alike
 *
 * `doStep()` moves the replay cursor and the price series with it. It does NOT
 * wait for studies to recompute — measured immediately after a replay start,
 * `bars().size()` was 0 and `reportData()` was null while `currentDate()` was
 * already set.
 *
 *   SERIES tier   time, open, high, low, close, volume, position,
 *                 realized_pl, log_count
 *                 Move with the step. Safe to predicate on per bar.
 *
 *   REPORT tier   trades
 *                 Comes from the strategy report, which lags the step by a
 *                 full recompute — 13-21s per bar on this chart. Predicating
 *                 on it without waiting reads the PREVIOUS bar's book, which
 *                 is the level-across-a-mutation trap in a new place.
 *
 * A report-tier field therefore requires `settle_each_step`, and the cost is
 * stated rather than hidden: it turns a ~300ms step into a ~20s one. Without
 * the flag the field is REFUSED, not silently served stale.
 */

/** Fields whose value moves with the step itself. */
export const SERIES_FIELDS = [
  'time',
  'open',
  'high',
  'low',
  'close',
  'volume',
  'position',
  'realized_pl',
  'log_count',
];

/** Fields that come from the strategy report and lag a full recompute. */
export const REPORT_FIELDS = ['trades'];

export const FIELDS = [...SERIES_FIELDS, ...REPORT_FIELDS];

export const OPS = ['gt', 'gte', 'lt', 'lte', 'eq', 'ne', 'changed'];

/**
 * Validate a predicate and say precisely what is wrong with it.
 *
 * A predicate that never fires and a predicate that cannot fire look the same
 * from the far end of a 500-bar run, so a typo in a field name has to be an
 * argument error up front rather than a `max_bars` result twenty minutes later.
 *
 * Accepts one clause, `{ all: [...] }`, or `{ any: [...] }`.
 */
export function validatePredicate(pred, { settleEachStep = false } = {}) {
  if (!pred || typeof pred !== 'object') {
    return { ok: false, error: 'predicate is required and must be an object.' };
  }
  const combinator = pred.all ? 'all' : pred.any ? 'any' : null;
  const clauses = combinator ? pred[combinator] : [pred];
  if (!Array.isArray(clauses) || clauses.length === 0) {
    return { ok: false, error: `predicate.${combinator || 'all'} must be a non-empty array of clauses.` };
  }
  for (const c of clauses) {
    if (!c || typeof c !== 'object') return { ok: false, error: 'Every clause must be an object { field, op, value }.' };
    if (!FIELDS.includes(c.field)) {
      return { ok: false, error: `Unknown predicate field "${c.field}". Available: ${FIELDS.join(', ')}.` };
    }
    if (!OPS.includes(c.op)) {
      return { ok: false, error: `Unknown operator "${c.op}" on field "${c.field}". Available: ${OPS.join(', ')}.` };
    }
    if (c.op !== 'changed' && (c.value === undefined || c.value === null)) {
      return { ok: false, error: `Clause on "${c.field}" with op "${c.op}" needs a value. Only "changed" takes none.` };
    }
    if (c.op !== 'changed' && typeof c.value !== 'number') {
      return { ok: false, error: `value on "${c.field}" must be a number; got ${typeof c.value}. Times are epoch MILLISECONDS.` };
    }
    if (REPORT_FIELDS.includes(c.field) && !settleEachStep) {
      return {
        ok: false,
        error:
          `"${c.field}" comes from the strategy report, which lags a replay step by a full recompute ` +
          '(13-21s per bar on a 45S chart). Read without waiting it describes the PREVIOUS bar. ' +
          'Pass settle_each_step to wait per bar and accept the cost, or predicate on a series field instead: ' +
          `${SERIES_FIELDS.join(', ')}.`,
      };
    }
  }
  return { ok: true, combinator: combinator || 'all', clauses };
}

/**
 * Page-context JS: read the replay state.
 *
 * Every value is normalised here rather than at the call site, because the
 * units differ from the rest of the codebase in exactly one place and it is
 * cheaper to fix at the boundary than to remember.
 */
const STATE_JS = `
  function __tvmcpReplayState(wantReport) {
    var rp = window.TradingViewApi._replayApi;
    function u(v) { return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; }
    var cw = window.TradingViewApi._activeChartWidgetWV.value();
    var model = cw._chartWidget.model();
    var st = {
      time: null, open: null, high: null, low: null, close: null, volume: null,
      position: null, realized_pl: null, log_count: null, trades: null,
      bars_loaded: null, ready_to_play: null
    };
    // currentDate() is SECONDS on this build; everything else here is ms.
    var d = u(rp.currentDate());
    st.time = (d == null) ? null : d * 1000;
    try { st.ready_to_play = u(rp.isReadyToPlay()); } catch (e) {}
    try {
      var bars = model.mainSeries().bars();
      st.bars_loaded = bars.size();
      var li = bars.lastIndex();
      if (li != null) {
        var b = bars.valueAt(li);
        // Bar tuple: [time, open, high, low, close, volume]
        if (b && b.length >= 5) {
          st.open = b[1]; st.high = b[2]; st.low = b[3]; st.close = b[4];
          st.volume = b.length > 5 ? b[5] : null;
        }
      }
    } catch (e) {}
    try { var p = u(rp.position()); st.position = (p == null) ? 0 : (typeof p === 'object' ? (p.qty != null ? p.qty : 0) : p); } catch (e) {}
    try { var r = u(rp.realizedPL()); st.realized_pl = (r == null) ? 0 : r; } catch (e) {}
    try {
      var srcs = model.model().dataSources();
      for (var i = 0; i < srcs.length; i++) {
        var id = null;
        try { id = typeof srcs[i].id === 'function' ? srcs[i].id() : srcs[i].id; } catch (e) { continue; }
        if (id !== __TVMCP_ENTITY) continue;
        try { var lg = srcs[i].logs(); st.log_count = lg ? (typeof lg.size === 'function' ? lg.size() : lg.size) : null; } catch (e) {}
        if (wantReport) {
          try {
            var rd = srcs[i].reportData();
            if (rd && typeof rd.value === 'function') rd = rd.value();
            st.trades = rd && rd.trades ? rd.trades.length : null;
          } catch (e) {}
        }
      }
    } catch (e) {}
    return st;
  }`;

/**
 * Page-context JS: step until the predicate holds.
 *
 * Returns `{ stopped_on, bars_advanced, state, start_state, elapsed_ms,
 * clause_results, step_ms }`. `stopped_on` is one of:
 *
 *   predicate     the predicate held. The only success.
 *   already_true  it held before a single step was taken. Reported separately
 *                 because "stopped after 0 bars" and "advanced to a bar where
 *                 this became true" are different answers to the question.
 *   max_bars      the bound was reached first.
 *   stalled       a step did not move currentDate within the per-step ceiling.
 *                 Usually the end of available replay data.
 *   deadline      the wall-clock budget ran out.
 */
export function stepUntilJs({
  entityId,
  combinator,
  clauses,
  maxBars,
  stepTimeoutMs,
  deadlineMs,
  settleEachStep,
  settleTimeoutMs,
}) {
  const wantReport = clauses.some((c) => REPORT_FIELDS.includes(c.field));
  return `
  (async function() {
    var __TVMCP_ENTITY = ${JSON.stringify(entityId)};
    ${STATE_JS}
    var rp = window.TradingViewApi._replayApi;
    function u(v) { return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; }
    var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var WANT_REPORT = ${wantReport ? 'true' : 'false'};
    var CLAUSES = ${JSON.stringify(clauses)};
    var COMB = ${JSON.stringify(combinator)};
    var MAX_BARS = ${Number(maxBars)};
    var STEP_TIMEOUT = ${Number(stepTimeoutMs)};
    var DEADLINE = ${Number(deadlineMs)};
    var SETTLE = ${settleEachStep ? 'true' : 'false'};
    var SETTLE_TIMEOUT = ${Number(settleTimeoutMs)};

    if (!u(rp.isReplayStarted())) {
      return { ok: false, reason: 'replay_not_started', error: 'Replay is not started. Use replay_start first.' };
    }

    var t0 = Date.now();
    var start = __tvmcpReplayState(WANT_REPORT);

    function evalClause(c, st) {
      var v = st[c.field];
      if (v == null) return { field: c.field, op: c.op, value: c.value, observed: null, held: false, undetermined: true };
      var held;
      if (c.op === 'changed') held = (start[c.field] != null) && (v !== start[c.field]);
      else if (c.op === 'gt') held = v > c.value;
      else if (c.op === 'gte') held = v >= c.value;
      else if (c.op === 'lt') held = v < c.value;
      else if (c.op === 'lte') held = v <= c.value;
      else if (c.op === 'eq') held = v === c.value;
      else if (c.op === 'ne') held = v !== c.value;
      else held = false;
      return { field: c.field, op: c.op, value: c.value === undefined ? null : c.value, observed: v, held: held };
    }
    function evalAll(st) {
      var res = CLAUSES.map(function (c) { return evalClause(c, st); });
      var held = COMB === 'any' ? res.some(function (r) { return r.held; })
                                : res.every(function (r) { return r.held; });
      return { held: held, results: res };
    }

    // Settling per step: wait for the study to finish recomputing. Only used
    // when a report-tier field is in play, because it costs a full recompute.
    async function settleStudy() {
      var deadline = Date.now() + SETTLE_TIMEOUT;
      var api = null;
      try { api = window.TradingViewApi._activeChartWidgetWV.value().getStudyById(__TVMCP_ENTITY); } catch (e) { return 'no_study'; }
      if (!api) return 'no_study';
      while (Date.now() < deadline) {
        var s = null;
        try { s = api.status(); } catch (e) { return 'unreadable'; }
        var t = s && s.type;
        if (t === 3) return 'errored';
        if (t === 2) return 'settled';
        await sleep(100);
      }
      return 'timed_out';
    }

    var first = evalAll(start);
    if (first.held) {
      return { ok: true, stopped_on: 'already_true', bars_advanced: 0, elapsed_ms: Date.now() - t0,
               start_state: start, state: start, clause_results: first.results };
    }

    var stepMs = [];
    var advanced = 0;
    var settleOutcome = null;
    for (var i = 0; i < MAX_BARS; i++) {
      if (Date.now() - t0 > DEADLINE) {
        var stD = __tvmcpReplayState(WANT_REPORT);
        return { ok: true, stopped_on: 'deadline', bars_advanced: advanced, elapsed_ms: Date.now() - t0,
                 start_state: start, state: stD, clause_results: evalAll(stD).results, step_ms: stepMs };
      }
      var before = u(rp.currentDate());
      var s0 = Date.now();
      try { rp.doStep(); } catch (e) {
        var stE = __tvmcpReplayState(WANT_REPORT);
        return { ok: false, reason: 'step_failed', error: String(e && e.message || e),
                 bars_advanced: advanced, state: stE };
      }
      // Wait on the EDGE. Measured 283-7711ms across ten consecutive steps, so
      // no fixed sleep is safe in either direction.
      var moved = false;
      var stepDeadline = Date.now() + STEP_TIMEOUT;
      while (Date.now() < stepDeadline) {
        await sleep(5);
        if (u(rp.currentDate()) !== before) { moved = true; break; }
      }
      if (!moved) {
        var stS = __tvmcpReplayState(WANT_REPORT);
        return { ok: true, stopped_on: 'stalled', bars_advanced: advanced, elapsed_ms: Date.now() - t0,
                 start_state: start, state: stS, clause_results: evalAll(stS).results, step_ms: stepMs,
                 ready_to_play: stS.ready_to_play };
      }
      stepMs.push(Date.now() - s0);
      advanced++;
      if (SETTLE) settleOutcome = await settleStudy();
      var st = __tvmcpReplayState(WANT_REPORT);
      var ev = evalAll(st);
      if (ev.held) {
        return { ok: true, stopped_on: 'predicate', bars_advanced: advanced, elapsed_ms: Date.now() - t0,
                 start_state: start, state: st, clause_results: ev.results, step_ms: stepMs,
                 settle_outcome: settleOutcome };
      }
    }
    var stM = __tvmcpReplayState(WANT_REPORT);
    return { ok: true, stopped_on: 'max_bars', bars_advanced: advanced, elapsed_ms: Date.now() - t0,
             start_state: start, state: stM, clause_results: evalAll(stM).results, step_ms: stepMs,
             settle_outcome: settleOutcome };
  })()`;
}

/** Summarise step latencies without returning one number per bar. */
export function summariseSteps(stepMs) {
  if (!Array.isArray(stepMs) || !stepMs.length) return null;
  const sorted = [...stepMs].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    steps: sorted.length,
    min_ms: sorted[0],
    median_ms: at(0.5),
    p90_ms: at(0.9),
    max_ms: sorted[sorted.length - 1],
    total_ms: stepMs.reduce((a, b) => a + b, 0),
  };
}


/**
 * Page-context JS: discard the replay session TradingView saves into the layout.
 *
 * `stopReplay()` is `requestCloseReplay(true)`, which calls
 * `_updateReplaySessionState()`. Unless replay ran to its END, that writes
 * `{ replayTime, replayMode, charts }` through
 * `chartWidgetCollection.updateReplaySessionState(state)` and marks the layout
 * changed, so the session is SAVED WITH THE LAYOUT. The next time the layout
 * loads or replay is entered, TradingView raises a modal — "Continue your last
 * replay? Start new / Continue" — that blocks the chart until someone clicks.
 *
 * Every programmatic replay stops mid-history, so every one of them left that
 * modal behind on the live research layout (observed 2026-09-11). Clearing it
 * is part of leaving replay, not an optional tidy-up. Returns the state before
 * and after so the caller can verify.
 */
export const CLEAR_REPLAY_SESSION_JS = `
  (function() {
    var cwc = window.TradingViewApi._chartWidgetCollection;
    function read() {
      try { var v = cwc.replaySessionState; if (typeof v === 'function') v = v.call(cwc); if (v && typeof v.value === 'function') v = v.value(); return v == null ? null : v; }
      catch (e) { return undefined; }
    }
    var before = read();
    try { cwc.updateReplaySessionState(null); } catch (e) { return { ok: false, error: String(e && e.message || e), had_saved_session: before != null }; }
    var after = read();
    return { ok: after === null, had_saved_session: before != null, cleared: before != null && after === null };
  })()`;
