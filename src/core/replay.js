/**
 * Core replay mode logic.
 */
import { evaluate as _evaluate, getReplayApi as _getReplayApi } from '../connection.js';
import { resolveEntity } from './pine-inputs.js';
import {
  HEALTH_JS,
  ReplayWedgeError,
  classifyHealth,
  currentOperation,
  withTransportLock,
} from '../internals/replay-transport.js';
import {
  CLEAR_REPLAY_SESSION_JS,
  OPS,
  REPORT_FIELDS,
  SERIES_FIELDS,
  stepUntilJs,
  summariseSteps,
  validatePredicate,
} from '../internals/replay.js';
import { adopt, answered, failed, observed, refused, withDetail } from '../internals/verdict.js';

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
  // Task 4: the whole arming sequence is one transport operation. selectDate()
  // initialises a server-side session, and issuing another while that is in
  // flight is the pattern that preceded the 2026-09-12 wedge.
  return withTransportLock('select_date', () => _start({ date, _deps }), { timeoutMs: 60000 });
}

async function _start({ date, _deps } = {}) {
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

  return observed(
    { is_replay_started: started, current_date: currentDate },
    { replay_started: true, date: date || '(first available)', current_date: currentDate },
  );
}

export async function step({ timeoutMs = 10000, _deps } = {}) {
  // The lock budget is deliberately larger than the polling budget: the poll
  // below decides "did not advance", and the lock decides "never settled at
  // all". Collapsing them would report a slow-but-working step as a wedge.
  return withTransportLock('step', () => _step({ timeoutMs, _deps }), { timeoutMs: timeoutMs + 10000 });
}

async function _step({ timeoutMs = 10000, _deps } = {}) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');
  const before = await evaluate(wv(`${rp}.currentDate()`));
  const t0 = Date.now();
  await evaluate(`${rp}.doStep()`);
  // doStep() resolves only when the SERVER-side replay session answers, and the
  // cursor moves with that answer — measured 283-7711ms across ten consecutive
  // steps, so no fixed sleep is safe in either direction. Poll the edge.
  let currentDate = before;
  while (Date.now() - t0 < timeoutMs) {
    await new Promise(r => setTimeout(r, 250));
    currentDate = await evaluate(wv(`${rp}.currentDate()`));
    if (currentDate !== before) break;
  }
  // DEFECT FIXED 2026-09-12: this used to `return { success: true }` whatever
  // the cursor did, so a replay session that had stopped answering reported a
  // successful step, over and over, while standing still. Measured live: a
  // wedged session (doStep()'s promise never settling) returned four
  // consecutive "successful" steps at an unchanged cursor. The timeout is
  // FAILURE DETECTION, not synchronisation: not moving is the failure.
  if (currentDate === before) {
    throw new Error(
      `Replay did not advance: the cursor is still ${currentDate} after ${Date.now() - t0}ms. `
      + "doStep() waits for the server-side replay session to answer, and it did not. "
      + 'A session in this state does not recover from stopReplay/selectDate/leaveReplay '
      + '(all three measured); reload the chart to re-establish it.',
    );
  }
  return observed(
    { cursor_before: before, cursor_after: currentDate },
    { action: 'step', current_date: currentDate, advanced_ms: Date.now() - t0 },
  );
}

export async function autoplay({ speed, _deps } = {}) {
  // Validate BEFORE any CDP calls — invalid values corrupt cloud account state permanently
  if (speed > 0 && !VALID_AUTOPLAY_DELAYS.includes(speed))
    throw new Error(`Invalid autoplay delay ${speed}ms. Valid values: ${VALID_AUTOPLAY_DELAYS.join(', ')}`);

  return withTransportLock(speed > 0 ? 'play' : 'pause', () => _autoplay({ speed, _deps }), { timeoutMs: 30000 });
}

async function _autoplay({ speed, _deps } = {}) {
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
  const detail = { autoplay_active: !!isAutoplay, delay_ms: currentDelay };
  // A speed is a request to PLAY, and toggleAutoplay() on a session already
  // playing pauses it instead — so reading "not playing" back is a refusal.
  // Without a speed the call is a documented toggle and states no target, so
  // the read-back is reported as what was seen.
  if (speed > 0 && !isAutoplay) {
    return refused(
      `Autoplay was requested at ${speed}ms, and isAutoplayStarted() reads false after the toggle.`,
      { ...detail, requested_delay_ms: speed },
    );
  }
  return observed({ is_autoplay_started: !!isAutoplay, autoplay_delay: currentDelay }, detail);
}

export async function stop({ _deps } = {}) {
  return withTransportLock('stop', () => _stop({ _deps }), { timeoutMs: 30000 });
}

async function _stop({ _deps } = {}) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  // Clear the saved session on BOTH paths. stopReplay() mid-history saves a
  // replay session into the layout, and TradingView then blocks the chart with
  // "Continue your last replay?" on the next load. A session left behind by an
  // earlier stop is cleared here too. See CLEAR_REPLAY_SESSION_JS.
  if (!started) {
    const session = await evaluate(CLEAR_REPLAY_SESSION_JS);
    if (session?.ok === false) {
      const error = 'Replay was not running, but the saved replay session could not be cleared; TradingView will ask "Continue your last replay?" on the next load.';
      return refused(error, { action: 'already_stopped', saved_session: session, error });
    }
    return observed({ is_replay_started: false, saved_session: session ?? null }, { action: 'already_stopped', saved_session: session });
  }
  await evaluate(`${rp}.stopReplay()`);
  const session = await evaluate(CLEAR_REPLAY_SESSION_JS);
  if (session?.ok === false) {
    const error = 'Replay stopped, but the saved replay session could not be cleared; TradingView will ask "Continue your last replay?" on the next load.';
    return refused(error, { action: 'replay_stopped', saved_session: session, error });
  }
  return observed({ saved_session: session ?? null }, { action: 'replay_stopped', saved_session: session });
}

/*
 * REMOVED 2026-09-12 (Phase 0.5, task 1): `trade({ action })`, and with it the
 * `replay_trade` tool and the `tv replay trade` CLI subcommand.
 *
 * It drove the replay API's buy / sell / close-position methods. That is an
 * ORDER PATH. On this build it happened to be inert: the buy method resolves
 * through `_replayUIController.tradingUIController()` to an optional-chained
 * model method, `updateModels()` took the `_initReplayBroker()` branch, the
 * `_tradingModelMap` stayed empty, the model resolved to null, and the optional
 * chain swallowed the whole call — so the tool answered `{ success: true }`
 * having submitted nothing. That is a property of THIS build, not of this code:
 * a build taking the legacy `_initTradingModels()` branch populates the map and
 * the identical call reaches the broker, from the DEFAULT (workflow) profile.
 *
 * Reporting success for an order that was never submitted is worse than either
 * submitting it or refusing outright, so the function is deleted rather than
 * guarded. `status()` below still READS `position()` and `realizedPL()`; reads
 * were never the hazard. Order emission belongs to the replay profile being
 * built under recon/PHASE0-FINDINGS.md, behind the broker interlock, and
 * nowhere else.
 *
 * tests/no-order-path.test.js keeps this surface clean, by name and by walking
 * the import graph of both profiles. It scans raw text, strings included (the
 * in-page calls ARE strings here), so this note deliberately avoids spelling
 * any of the banned call sites literally.
 */

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
  return answered({ ...st, position: pos, realized_pnl: pnl });
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
    return failed('invalid_argument', { error: `max_bars must be a positive number; got "${maxBars}".` });
  }
  const bound = Math.floor(n);

  const v = validatePredicate(predicate, { settleEachStep });
  if (!v.ok) {
    return failed('invalid_argument', {
      error: v.error,
      fields: { series: SERIES_FIELDS, report: REPORT_FIELDS },
      operators: OPS,
    });
  }

  // Resolve the study explicitly even though most predicates do not need one:
  // log_count and trades both do, and a chart carrying two builds must refuse
  // rather than counting whichever came first out of dataSources().
  const needsStudy = v.clauses.some((c) => c.field === 'log_count' || REPORT_FIELDS.includes(c.field));
  let entity = null;
  if (needsStudy || entityId) {
    const r = await resolveEntity({ hint: entityId, _deps });
    if (!r.ok) {
      return failed(r.reason === 'ambiguous' ? 'ambiguous_entity' : r.reason, {
        error: r.error,
        candidates: r.candidates,
      });
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
  if (!out) return failed('no_result', { error: 'The page returned nothing.' });
  if (out.ok === false) return adopt(out, { defaultReason: 'step_failed' });

  const steps = summariseSteps(out.step_ms);
  const undetermined = (out.clause_results || []).filter((c) => c.undetermined);

  const detail = {
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
  // The page counts a bar only once currentDate() has moved past it, so a
  // non-zero count IS the read-back. Zero bars advanced (already_true, or a
  // stall on the first step) changed nothing, and claims nothing.
  if (out.bars_advanced > 0) {
    return observed(
      {
        bars_advanced: out.bars_advanced,
        cursor_before: out.start_state?.time ?? null,
        cursor_after: out.state?.time ?? null,
      },
      detail,
    );
  }
  return answered(detail);
}

/**
 * Distinguish "armed and idle" from "wedged".
 *
 * The wedged session on 2026-09-12 reported sessionState 2, connected true,
 * isReplayStarted true, isReplayFinished false — i.e. every flag a caller would
 * naturally check said the session was fine, while doStep() never settled and
 * the cursor sat at 1788220799. No single field distinguishes the two states,
 * so this reads them together and, when asked, ATTEMPTS A STEP: the only
 * reliable discriminator found is whether the cursor can actually be moved.
 *
 * `probe` defaults to false because the probe advances the replay cursor by one
 * bar, which is a state change and must be asked for rather than assumed.
 */
export async function health({ probe = false, timeoutMs = 12000, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const raw = await evaluate(HEALTH_JS);
  const reading = typeof raw === 'string' ? JSON.parse(raw) : raw;

  let probeResult;
  if (probe && reading?.is_replay_started === true) {
    probeResult = await withTransportLock(
      'step',
      () => _probeStep({ timeoutMs, _deps }),
      { timeoutMs: timeoutMs + 10000 },
    ).catch((err) => {
      // A lock timeout IS the wedge signal, not an error to propagate: the whole
      // point of this call is to report that state rather than throw it.
      if (err instanceof ReplayWedgeError) {
        return { advanced: false, settled: false, waited_ms: err.elapsed_ms ?? timeoutMs, error: err.message };
      }
      throw err;
    });
  }

  const classification = classifyHealth(reading, probeResult);
  // The raw reading was once named `state`, and `classification.state` is the
  // classification; spreading the classification first let the reading
  // overwrite it — caught live on 2026-09-12 when this returned the reading
  // object where 'healthy' belonged. That is the same shape as the
  // pine_inputs_assert defect this phase fixed, written by the same hand that
  // fixed it an hour earlier, which is the whole argument for
  // internals/verdict.js: the shape has to be impossible, because knowing about
  // it is demonstrably not enough. The reading is now `reading`, and it is added
  // through withDetail(), which throws on ANY key the classification already
  // carries — so a future `state` here is an error, not an overwrite.
  return withDetail(answered(classification), {
    probe: probeResult ?? null,
    transport_in_flight: currentOperation(),
    reading,
  });
}

/**
 * One step attempt that reports what happened instead of throwing.
 *
 * Deliberately not `step()`: step() throws on a cursor that does not move,
 * which is correct for a caller trying to advance replay and wrong for a health
 * check, whose entire job is to return that fact as data.
 */
async function _probeStep({ timeoutMs, _deps }) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const before = await evaluate(wv(`${rp}.currentDate()`));
  const t0 = Date.now();
  let settled = false;
  // Fire doStep and watch whether its promise ever resolves, separately from
  // whether the cursor moves — they are different failures and the message
  // the caller gets should say which one happened.
  const settledFlag = evaluate(
    `(function(){ var rp = ${rp}; var p = rp.doStep(); `
    + 'return (p && typeof p.then === "function") ? p.then(function(){ return true; }, function(){ return true; }) : true; })()',
    { awaitPromise: true },
  ).then(() => { settled = true; }).catch(() => { settled = true; });

  let current = before;
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 250));
    current = await evaluate(wv(`${rp}.currentDate()`));
    if (current !== before) break;
  }
  // Give the promise a final moment so "settled late" is not misread as "never".
  await Promise.race([settledFlag, new Promise((r) => setTimeout(r, 250))]);
  return {
    advanced: current !== before,
    settled,
    waited_ms: Date.now() - t0,
    before_date: before,
    after_date: current,
  };
}
