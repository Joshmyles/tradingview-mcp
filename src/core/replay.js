/**
 * Core replay mode logic.
 */
import { evaluate as _evaluate, getReplayApi as _getReplayApi } from '../connection.js';
import { resolveEntity } from './pine-inputs.js';
import {
  CLEAR_REPLAY_SESSION_JS,
  OPS,
  REPORT_FIELDS,
  SERIES_FIELDS,
  stepUntilJs,
  summariseSteps,
  validatePredicate,
} from '../internals/replay.js';

export const VALID_AUTOPLAY_DELAYS = [100, 143, 200, 300, 1000, 2000, 3000, 5000, 10000];

function wv(path) {
  return `(function(){ var v = ${path}; return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; })()`;
}

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    getReplayApi: deps?.getReplayApi || _getReplayApi,
  };
}

export async function start({ date, _deps } = {}) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const available = await evaluate(wv(`${rp}.isReplayAvailable()`));
  if (!available) throw new Error('Replay is not available for the current symbol/timeframe');

  await evaluate(`${rp}.showReplayToolbar()`);

  // selectDate() is async — it calls enableReplayMode() then _onPointSelected()
  // which initializes the server-side replay session. Must be awaited inside the
  // page context, otherwise the promise is fire-and-forget and replay state says
  // "started" but stepping doesn't work (issue #26).
  if (date) {
    const ts = new Date(date).getTime();
    if (isNaN(ts)) throw new Error(`Invalid date: "${date}". Use YYYY-MM-DD format.`);
    await evaluate(`${rp}.selectDate(${ts}).then(function() { return 'ok'; })`);
  } else {
    await evaluate(`${rp}.selectFirstAvailableDate()`);
  }

  // Poll until replay is fully initialized: isReplayStarted AND currentDate is set.
  // selectDate()'s promise resolves before the data series is ready, so we need
  // to wait for currentDate to become non-null before stepping will work.
  let started = false;
  let currentDate = null;
  for (let i = 0; i < 30; i++) {
    started = await evaluate(wv(`${rp}.isReplayStarted()`));
    currentDate = await evaluate(wv(`${rp}.currentDate()`));
    if (started && currentDate !== null) break;
    await new Promise(r => setTimeout(r, 250));
  }

  if (!started) {
    try { await evaluate(`${rp}.stopReplay()`); } catch {}
    try { await evaluate(CLEAR_REPLAY_SESSION_JS); } catch {}
    throw new Error('Replay failed to start. The selected date may not have data for this timeframe. Try a more recent date or a higher timeframe (e.g., Daily).');
  }

  return { success: true, replay_started: true, date: date || '(first available)', current_date: currentDate };
}

export async function step({ _deps } = {}) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');
  const before = await evaluate(wv(`${rp}.currentDate()`));
  await evaluate(`${rp}.doStep()`);
  // doStep() is async internally — currentDate takes ~500ms to update.
  // Poll until it changes or timeout after 3s.
  let currentDate = before;
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 250));
    currentDate = await evaluate(wv(`${rp}.currentDate()`));
    if (currentDate !== before) break;
  }
  return { success: true, action: 'step', current_date: currentDate };
}

export async function autoplay({ speed, _deps } = {}) {
  // Validate BEFORE any CDP calls — invalid values corrupt cloud account state permanently
  if (speed > 0 && !VALID_AUTOPLAY_DELAYS.includes(speed))
    throw new Error(`Invalid autoplay delay ${speed}ms. Valid values: ${VALID_AUTOPLAY_DELAYS.join(', ')}`);

  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');
  if (speed > 0) {
    await evaluate(`${rp}.changeAutoplayDelay(${speed})`);
  }
  await evaluate(`${rp}.toggleAutoplay()`);
  const isAutoplay = await evaluate(wv(`${rp}.isAutoplayStarted()`));
  const currentDelay = await evaluate(wv(`${rp}.autoplayDelay()`));
  return { success: true, autoplay_active: !!isAutoplay, delay_ms: currentDelay };
}

export async function stop({ _deps } = {}) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  // Clear the saved session on BOTH paths. stopReplay() mid-history saves a
  // replay session into the layout, and TradingView then blocks the chart with
  // "Continue your last replay?" on the next load. A session left behind by an
  // earlier stop is cleared here too. See CLEAR_REPLAY_SESSION_JS.
  if (!started) {
    const session = await evaluate(CLEAR_REPLAY_SESSION_JS);
    return { success: true, action: 'already_stopped', saved_session: session };
  }
  await evaluate(`${rp}.stopReplay()`);
  const session = await evaluate(CLEAR_REPLAY_SESSION_JS);
  return {
    success: session?.ok !== false,
    action: 'replay_stopped',
    saved_session: session,
    ...(session?.ok === false && {
      error: 'Replay stopped, but the saved replay session could not be cleared; TradingView will ask "Continue your last replay?" on the next load.',
    }),
  };
}

export async function trade({ action, _deps }) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');

  if (action === 'buy') await evaluate(`${rp}.buy()`);
  else if (action === 'sell') await evaluate(`${rp}.sell()`);
  else if (action === 'close') await evaluate(`${rp}.closePosition()`);
  else throw new Error('Invalid action. Use: buy, sell, or close');

  const position = await evaluate(wv(`${rp}.position()`));
  const pnl = await evaluate(wv(`${rp}.realizedPL()`));
  return { success: true, action, position, realized_pnl: pnl };
}

export async function status({ _deps } = {}) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const st = await evaluate(`
    (function() {
      var r = ${rp};
      function unwrap(v) { return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; }
      return {
        is_replay_available: unwrap(r.isReplayAvailable()),
        is_replay_started: unwrap(r.isReplayStarted()),
        is_autoplay_started: unwrap(r.isAutoplayStarted()),
        replay_mode: unwrap(r.replayMode()),
        current_date: unwrap(r.currentDate()),
        autoplay_delay: unwrap(r.autoplayDelay()),
      };
    })()
  `);
  const pos = await evaluate(wv(`${rp}.position()`));
  const pnl = await evaluate(wv(`${rp}.realizedPL()`));
  return { success: true, ...st, position: pos, realized_pnl: pnl };
}


/**
 * Advance replay until a predicate holds, returning ONLY the stopping state.
 *
 * The loop runs inside the page — see internals/replay.js for why, for the
 * seconds-vs-milliseconds trap on `currentDate()`, and for the two tiers of
 * observable. Nothing per-bar comes back: the point of the tool is to skip the
 * bars, and returning 500 intermediate states would cost more than stepping
 * them by hand.
 *
 * This is a MUTATION. It leaves replay wherever it stopped, deliberately —
 * the stopping bar IS the deliverable, and rewinding it would throw away the
 * thing the caller asked for. `replay_stop` returns to realtime.
 */
export async function stepUntil({
  predicate,
  maxBars = 500,
  entityId = null,
  stepTimeoutMs = 30000,
  deadlineMs = 240000,
  settleEachStep = false,
  settleTimeoutMs = 45000,
  _deps,
} = {}) {
  const evaluateAsyncFn =
    _deps?.evaluateAsync || ((expr) => (_deps?.evaluate || _evaluate)(expr, { awaitPromise: true }));

  const n = Number(maxBars);
  if (!Number.isFinite(n) || n < 1) {
    return { ok: false, reason: 'invalid_argument', error: `max_bars must be a positive number; got "${maxBars}".` };
  }
  const bound = Math.floor(n);

  const v = validatePredicate(predicate, { settleEachStep });
  if (!v.ok) {
    return {
      ok: false,
      reason: 'invalid_argument',
      error: v.error,
      fields: { series: SERIES_FIELDS, report: REPORT_FIELDS },
      operators: OPS,
    };
  }

  // Resolve the study explicitly even though most predicates do not need one:
  // log_count and trades both do, and a chart carrying two builds must refuse
  // rather than counting whichever came first out of dataSources().
  const needsStudy = v.clauses.some((c) => c.field === 'log_count' || REPORT_FIELDS.includes(c.field));
  let entity = null;
  if (needsStudy || entityId) {
    const r = await resolveEntity({ hint: entityId, _deps });
    if (!r.ok) {
      return {
        ok: false,
        reason: r.reason === 'ambiguous' ? 'ambiguous_entity' : r.reason,
        error: r.error,
        candidates: r.candidates,
      };
    }
    entity = r.resolved;
  }

  const out = await evaluateAsyncFn(
    stepUntilJs({
      entityId: entity?.entity_id ?? null,
      combinator: v.combinator,
      clauses: v.clauses,
      maxBars: bound,
      stepTimeoutMs,
      deadlineMs,
      settleEachStep,
      settleTimeoutMs,
    }),
  );
  if (!out) return { ok: false, reason: 'no_result', error: 'The page returned nothing.' };
  if (out.ok === false) return out;

  const steps = summariseSteps(out.step_ms);
  const undetermined = (out.clause_results || []).filter((c) => c.undetermined);

  return {
    ok: true,
    stopped_on: out.stopped_on,
    matched: out.stopped_on === 'predicate' || out.stopped_on === 'already_true',
    bars_advanced: out.bars_advanced,
    elapsed_ms: out.elapsed_ms,
    max_bars: bound,
    ...(entity && { entity_id: entity.entity_id, entity_title: entity.title }),
    predicate: { [v.combinator]: v.clauses },
    clause_results: out.clause_results,
    state: out.state,
    start_state: out.start_state,
    ...(steps && { step_latency: steps }),
    ...(out.settle_outcome && { settle_outcome: out.settle_outcome }),
    ...(undetermined.length && {
      undetermined: undetermined.map((c) => c.field),
      warning:
        `Field(s) ${undetermined.map((c) => c.field).join(', ')} read as null at the stopping bar, so those ` +
        'clauses could not be evaluated and were treated as NOT held. A null here is usually the series or the ' +
        'report not having caught up, not a value of zero.',
    }),
    note:
      out.stopped_on === 'stalled'
        ? 'A step did not move the replay cursor within the per-step ceiling. This is normally the end of available replay data, not a fault.'
        : out.stopped_on === 'max_bars'
          ? 'The bound was reached and the predicate never held. Replay is left at the last bar stepped; this is not a failure, it is the answer.'
          : out.stopped_on === 'already_true'
            ? 'The predicate held before any step was taken. Nothing was advanced.'
            : 'Replay is left AT the stopping bar deliberately — that bar is the result. Use replay_stop to return to realtime.',
  };
}
