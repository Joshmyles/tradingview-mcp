/**
 * Phase 0.6 — snapshot the replay session state. Run BEFORE the reload to
 * record the wedge, and AFTER it to show the transition. Read-only.
 *
 * The point of running the same probe both sides is that "recovered" has to be
 * a measured difference, not an impression.
 */
import { evaluate } from '../src/connection.js';

const JS = `
(function () {
  function u(v) { return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; }
  function safe(fn, d) { try { return u(fn()); } catch (e) { return d === undefined ? ('ERR:' + String(e && e.message || e)) : d; } }
  var out = { at: new Date().toISOString() };
  var rp = null;
  try { rp = window.TradingViewApi._replayApi; } catch (e) {}
  out.replay_api_present = !!rp;
  if (rp) {
    out.is_replay_started = safe(function () { return rp.isReplayStarted(); });
    out.is_replay_finished = safe(function () { return rp.isReplayFinished(); });
    out.current_date = safe(function () { return rp.currentDate(); });
    out.is_playing = safe(function () { return rp.isPlaying ? rp.isPlaying() : 'n/a'; });
    out.session_id = safe(function () { return rp._replaySession && rp._replaySession.id; });
    out.session_state = safe(function () { return rp._replaySession && u(rp._replaySession.state); });
    out.connected = safe(function () { return rp._replaySession && u(rp._replaySession.connected); });
  }
  try {
    var cw = window.TradingViewApi._activeChartWidgetWV.value();
    out.replay_status = safe(function () { return cw._chartWidget.replayStatus(); });
    out.symbol = safe(function () { return String(cw._chartWidget.model().model().mainSeries().symbol()); });
    out.interval = safe(function () { return String(cw._chartWidget.model().model().mainSeries().interval()); });
    out.bar_count = safe(function () { return cw._chartWidget.model().model().mainSeries().bars().size(); });
  } catch (e) { out.chart_error = String(e && e.message || e); }
  var req = null;
  try { window.webpackChunktradingview.push([[Math.random()], {}, function (r) { req = r; }]); } catch (e) {}
  if (req) {
    try {
      var ts = req('822530').tradingService();
      out.is_in_replay = safe(function () { return ts.isInReplay(); });
      var ab = ts.activeBroker();
      out.current_broker = ab ? safe(function () { return ab.currentBroker(); }) : null;
    } catch (e) { out.trading_service_error = String(e && e.message || e); }
  }
  return JSON.stringify(out);
})()`;

console.log(await evaluate(JS));
process.exit(0);
