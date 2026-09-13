/**
 * The §2.4 broker interlock: refuse unless the active order destination IS the
 * Replay Trading broker.
 *
 * ── IT IS AN ALLOWLIST, NOT A DENYLIST ─────────────────────────────────────
 *
 * The brief frames this as "if any real or Paper Trading broker connection is
 * detected as the active order destination, refuse". Implemented literally that
 * is a denylist, and a denylist over `brokersList()` — 137 brokers on this
 * session — fails open on the 138th. The guard here inverts it: the ONLY
 * accepted state is
 *
 *     currentBroker() === "REPLAYBROKER"   (InternalBrokerId.ReplayBroker)
 *     && tradingService().isInReplay() === true
 *     && replayApi.isReplayStarted() === true
 *
 * and anything else — Paper, a real broker, an unreadable value, a missing
 * broker, an error — is a refusal. Unknown is a refusal: §2.1 says a check that
 * "cannot be established with certainty" errors out, so the absent case and the
 * wrong case take the same branch deliberately.
 *
 * All three clauses are required and none is redundant:
 *   currentBroker()      names the order DESTINATION. Necessary, not sufficient:
 *                        it can read REPLAYBROKER while the chart has left
 *                        replay, and an order then has no bar to fill on.
 *   isInReplay()         says the TRADING SERVICE is in replay mode.
 *   isReplayStarted()    says the CHART's replay session is actually running.
 *                        Without it a "REPLAYBROKER + isInReplay" state that is
 *                        merely armed would pass.
 *
 * ── THE NAMING TRAP, WHICH IS WHY THE TEST BELOW EXISTS ────────────────────
 *
 * `tradingUIController()._isConnectedToBroker` reads like the thing to refuse
 * on — "a broker is connected, so bail out". It means the OPPOSITE: connected
 * to the REPLAY broker. Measured live 2026-09-12 with the Replay Trading panel
 * open and `currentBroker()` reading "REPLAYBROKER", it was `true`. Using it as
 * the refusal signal inverts the interlock: the harness would refuse in exactly
 * the state it is supposed to run in, and — far worse — would ARM in the state
 * where the replay broker is absent. It is never read here, and
 * tests/replay-interlock.test.js pins that, because a comment is not a
 * mechanism.
 *
 * Nothing in this module writes. It reads three values and decides.
 */
import { evaluate as _evaluate } from '../connection.js';

/** InternalBrokerId.ReplayBroker, read from the live enum 2026-09-12. */
export const REQUIRED_BROKER_ID = 'REPLAYBROKER';

/** Brokers that must never be the destination. Recorded for the refusal text
 *  only — the guard is the allowlist above, not this list. */
export const FORBIDDEN_BROKER_IDS = Object.freeze({
  Paper: 'Paper',
  Dummy: 'DUMMY',
  MockBroker: 'MOCKBROKER',
  MockBrokerImplicit: 'MOCKBROKER_IMPLICIT',
  MockBrokerCode: 'MOCKBROKER_CODE',
});

export class InterlockError extends Error {
  constructor(message, state) {
    super(message);
    this.name = 'InterlockError';
    this.state = state;
  }
}

/**
 * Page-context JS reading the three interlock signals in ONE round trip.
 *
 * One round trip on purpose: three separate evaluates could straddle a broker
 * change and see a state that never existed. `_isConnectedToBroker` is read too
 * — recorded on the result as `naming_trap_do_not_use` so the trap is visible
 * in a journal — but it is never consulted by the decision below.
 */
export const INTERLOCK_JS = `
(function () {
  function u(v) { return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; }
  var out = { ok: false };
  var req = null;
  try { window.webpackChunktradingview.push([[Math.random()], {}, function (r) { req = r; }]); }
  catch (e) { out.error = 'webpack registry unreachable: ' + String(e && e.message || e); return out; }
  if (!req) { out.error = 'webpack registry unreachable'; return out; }
  var ts;
  try { ts = req('822530').tradingService(); }
  catch (e) { out.error = 'tradingService() unreachable: ' + String(e && e.message || e); return out; }
  try { out.is_in_replay = u(ts.isInReplay()); } catch (e) { out.is_in_replay_error = String(e && e.message || e); }
  try {
    var ab = ts.activeBroker();
    out.has_active_broker = !!ab;
    if (ab) {
      try { out.current_broker = u(ab.currentBroker()); } catch (e) { out.current_broker_error = String(e && e.message || e); }
      try { out.connection_status = u(ab.connectionStatus()); } catch (e) {}
      try { out.account = String(u(ab.currentAccount())); } catch (e) {}
      try { out.account_type = String(u(ab.currentAccountType())); } catch (e) {}
    }
  } catch (e) { out.active_broker_error = String(e && e.message || e); }
  try {
    var rp = window.TradingViewApi._replayApi;
    out.is_replay_started = u(rp.isReplayStarted());
    out.replay_cursor_sec = u(rp.currentDate());
  } catch (e) { out.replay_error = String(e && e.message || e); }
  try {
    var tu = window.TradingViewApi._replayApi._replayUIController.tradingUIController();
    out.naming_trap_do_not_use = tu ? tu._isConnectedToBroker : null;
  } catch (e) {}
  out.ok = true;
  return out;
})()`;

/**
 * Decide from an already-read state. Pure, so it can be tested without a chart.
 *
 * @returns {{armed: boolean, reasons: string[]}}
 */
export function evaluateInterlock(state) {
  const reasons = [];
  if (!state || state.ok !== true) {
    reasons.push(`the interlock state could not be read${state?.error ? `: ${state.error}` : ''}`);
    return { armed: false, reasons };
  }
  if (state.current_broker !== REQUIRED_BROKER_ID) {
    const named = Object.entries(FORBIDDEN_BROKER_IDS).find(([, v]) => v === state.current_broker);
    reasons.push(
      `the active order destination is ${state.current_broker == null ? 'unreadable' : `"${state.current_broker}"`}`
      + `${named ? ` (${named[0]} Trading)` : ''}, not "${REQUIRED_BROKER_ID}"`,
    );
  }
  if (state.is_in_replay !== true) {
    reasons.push(`tradingService().isInReplay() is ${JSON.stringify(state.is_in_replay)}, not true`);
  }
  if (state.is_replay_started !== true) {
    reasons.push(`replayApi.isReplayStarted() is ${JSON.stringify(state.is_replay_started)}, not true`);
  }
  return { armed: reasons.length === 0, reasons };
}

/**
 * Read the state and throw unless the harness may emit an order.
 *
 * Called immediately before acting, every time — never cached. A broker can
 * change under the harness between one bar and the next.
 */
export async function assertReplayBrokerInterlock({ _deps } = {}) {
  const evaluate = _deps?.evaluate || _evaluate;
  let state;
  try {
    state = await evaluate(INTERLOCK_JS);
  } catch (err) {
    throw new InterlockError(
      `REFUSING TO ARM: the broker interlock could not be read (${err.message}). `
      + 'A check that cannot be established with certainty is a refusal.',
      { error: err.message },
    );
  }
  const { armed, reasons } = evaluateInterlock(state);
  if (!armed) {
    throw new InterlockError(
      `REFUSING TO ARM: ${reasons.join('; ')}. `
      + 'The harness emits orders only into a running Replay Trading session. '
      + 'It does not fall back, retry against another destination, or best-effort it.',
      state,
    );
  }
  return {
    armed: true,
    broker: state.current_broker,
    account: state.account,
    account_type: state.account_type,
    connection_status: state.connection_status,
    replay_cursor_sec: state.replay_cursor_sec,
  };
}
