/**
 * Single-flight serialisation for replay transport, and a wedge detector.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────
 *
 * The replay session on the live chart wedged on 2026-09-12 following roughly
 * fifteen `selectDate` calls issued in quick succession while Replay Trading
 * was armed. In the wedged state `doStep()` returns a promise that NEVER
 * settles and autoplay advances nothing, while the session reports itself
 * connected, started and unfinished. Four recovery routes were measured and
 * none worked — `stopReplay()` + `start`, `leaveReplay()`, removing the
 * `<chartId>_additional` model, and `disconnectionSessionIfExists()`. The only
 * recovery found is a chart reload.
 *
 * The causal chain was never proven, and this module does not claim it. What is
 * certain is narrower and sufficient: replay transport is a stateful,
 * server-backed session, the harness drove it concurrently and at speed, and a
 * recovery costs a reload. So transport is serialised here whether or not
 * concurrency was the cause, because the cost of the guard is a few hundred
 * milliseconds and the cost of the failure is the user's chart.
 *
 * ── WHAT THIS DOES NOT CLAIM ───────────────────────────────────────────────
 *
 * A lock inside one Node process does not make the chart safe. Anything else
 * touching the same chart — a second harness process, the TradingView UI under
 * the user's own hand — is outside it. This narrows a window; it does not close
 * one.
 *
 * ── TIMEOUTS ───────────────────────────────────────────────────────────────
 *
 * Every transport call is bounded, and a timeout is reported as a NAMED wedge
 * condition rather than as a generic stall, because the two call for different
 * responses: a slow server is worth waiting for again, a wedged session is not
 * and needs a reload.
 */

/** Thrown when a transport call did not settle inside its budget. */
export class ReplayWedgeError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'ReplayWedgeError';
    this.wedged = true;
    Object.assign(this, detail);
  }
}

/** Thrown when a caller tries to drive transport while another call is in flight. */
export class TransportBusyError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'TransportBusyError';
    Object.assign(this, detail);
  }
}

// ---- The lock. Module-scoped on purpose: one chart, one transport queue.
let inFlight = null;          // { op, startedAt }
let queue = Promise.resolve();

/** What the transport is doing right now, for diagnostics and for replay_health. */
export function currentOperation() {
  if (!inFlight) return null;
  return { op: inFlight.op, elapsed_ms: Date.now() - inFlight.startedAt };
}

/** Test seam: drop any in-flight marker and reset the queue. */
export function _resetTransportLock() {
  inFlight = null;
  queue = Promise.resolve();
}

/**
 * Run `fn` with exclusive access to replay transport.
 *
 * Calls QUEUE rather than fail — replay work is naturally a sequence of steps,
 * and making a caller retry a step because another step was running would just
 * move the serialisation into every call site. The exception is `selectDate`:
 * moving the cursor while a step is outstanding is the specific pattern that
 * preceded the wedge, so that combination is refused outright rather than
 * queued behind it.
 *
 * @param {string} op         'select_date' | 'step' | 'play' | 'pause' | 'stop' | 'start'
 * @param {() => Promise<T>} fn
 * @param {{timeoutMs?: number}} [opts]
 */
export function withTransportLock(op, fn, { timeoutMs = 30000 } = {}) {
  // The refusal is checked at CALL time, against whatever is in flight now —
  // not after queueing, by which point the step it must not race has finished
  // and the check would be vacuous.
  if (op === 'select_date' && inFlight && inFlight.op === 'step') {
    return Promise.reject(new TransportBusyError(
      `refusing to move the replay cursor while a step is in flight (${Date.now() - inFlight.startedAt}ms so far). `
      + 'Rapid selectDate calls against an active session preceded the 2026-09-12 wedge, '
      + 'whose only recovery is a chart reload.',
      { requested_op: op, in_flight: currentOperation() },
    ));
  }

  const run = async () => {
    inFlight = { op, startedAt: Date.now() };
    const startedAt = inFlight.startedAt;
    try {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new ReplayWedgeError(
            `replay transport operation "${op}" did not settle within ${timeoutMs}ms. `
            + 'This is the signature of a WEDGED replay session: doStep() returns a promise that '
            + 'never settles while the session still reports itself connected and started. '
            + 'It is not recoverable by stopReplay/leaveReplay/selectDate (all measured 2026-09-12); '
            + 'reload the chart. Call replay_health for the full state.',
            { op, timeout_ms: timeoutMs, elapsed_ms: Date.now() - startedAt },
          ));
        }, timeoutMs);
      });
      try {
        return await Promise.race([fn(), timeout]);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      inFlight = null;
    }
  };

  // Chain onto the queue, and keep the queue alive after a rejection so one
  // failed step does not poison every later call.
  const result = queue.then(run, run);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

/**
 * Page-context JS reading everything needed to tell "armed and idle" from
 * "wedged", in one round trip.
 *
 * One round trip matters: the distinguishing evidence is a RELATIONSHIP between
 * values (the session says started, the cursor says frozen), and reading them
 * across several evaluates can compose a state that never existed.
 */
export const HEALTH_JS = `
(function () {
  function u(v) { return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; }
  function safe(fn, d) { try { return u(fn()); } catch (e) { return d === undefined ? null : d; } }
  var out = { read_at: Date.now() };
  var rp = null;
  try { rp = window.TradingViewApi._replayApi; } catch (e) {}
  out.replay_api_present = !!rp;
  if (rp) {
    out.is_replay_available = safe(function () { return rp.isReplayAvailable(); });
    out.is_replay_started = safe(function () { return rp.isReplayStarted(); });
    out.is_autoplay_started = safe(function () { return rp.isAutoplayStarted(); });
    out.current_date = safe(function () { return rp.currentDate(); });
    out.autoplay_delay = safe(function () { return rp.autoplayDelay(); });
    var sess = safe(function () { return rp._replaySession; });
    if (sess) {
      out.session_id = safe(function () { return sess.id; });
      out.session_state = safe(function () { return sess.state; });
      out.session_connected = safe(function () { return sess.connected; });
    }
  }
  try {
    var cw = window.TradingViewApi._activeChartWidgetWV.value();
    var ms = cw._chartWidget.model().model().mainSeries();
    out.symbol = safe(function () { return String(ms.symbol()); });
    out.interval = safe(function () { return String(ms.interval()); });
    out.bar_count = safe(function () { return ms.bars().size(); });
    var b = ms.bars();
    var last = safe(function () { var v = b.valueAt(b.lastIndex()); return v && v[0]; });
    out.last_bar_time = last;
  } catch (e) { out.chart_error = String(e && e.message || e); }
  return JSON.stringify(out);
})()`;

/**
 * Classify a health reading.
 *
 * Pure, so the classification is testable without a chart — which matters
 * because the wedged state is expensive to reproduce deliberately.
 *
 * @param {object} now     a HEALTH_JS reading
 * @param {object} [probe] { advanced: boolean, settled: boolean, waited_ms: number }
 *                         from an optional active step probe
 */
export function classifyHealth(now, probe) {
  if (!now || now.replay_api_present !== true) {
    return { state: 'no_replay_api', armed: false, wedged: false, why: 'window.TradingViewApi._replayApi is not present' };
  }
  if (now.is_replay_started !== true) {
    return {
      state: 'not_started',
      armed: false,
      wedged: false,
      why: 'replay is not started; the chart is in normal (non-replay) mode',
    };
  }
  // Started. The question is whether it can still move.
  if (probe) {
    if (probe.advanced) {
      return { state: 'healthy', armed: true, wedged: false, why: `the cursor advanced during the probe (${probe.waited_ms}ms)` };
    }
    if (probe.settled === false) {
      return {
        state: 'wedged',
        armed: true,
        wedged: true,
        why: `doStep() did not settle within ${probe.waited_ms}ms and the cursor did not move, while the session `
          + `reports started=${now.is_replay_started} connected=${now.session_connected}. `
          + 'That combination is the wedge signature measured 2026-09-12; recovery is a chart reload.',
      };
    }
    return {
      state: 'stalled',
      armed: true,
      wedged: true,
      why: `doStep() settled but the cursor did not move within ${probe.waited_ms}ms. `
        + 'A settled call that changes nothing is still a session that cannot be driven.',
    };
  }
  return {
    state: 'armed_unprobed',
    armed: true,
    wedged: false,
    why: 'replay is started; no step was attempted, so whether it can advance is unknown. '
      + 'Call replay_health with probe:true to find out.',
  };
}
