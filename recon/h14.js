(async function () {
  function u(v){ return (v && typeof v==='object' && typeof v.value==='function') ? v.value() : v; }
  var rp = window.TradingViewApi._replayApi;
  var rm = rp._replayUIController._replayManager;
  var out = {};
  try { out.sessionState = String(rm._replaySession._state); } catch(e){ out.stateErr = String(e && e.message || e); }
  try { out.sessionId = String(u(rm._replaySession._sessionId)); } catch(e){}
  try { out.sessionConnected = String(u(rm._replaySession._isConnected)); } catch(e){}
  try { out.chartApiConnected = String(u(window.ChartApiInstance && window.ChartApiInstance.connected ? window.ChartApiInstance.connected() : null)); } catch(e){ out.chartApiErr = String(e && e.message || e); }
  try { out.replayStatus = String(u(rm.replayStatusWV())); } catch(e){}
  try { out.replayPoint = u(rm.replayPoint()); } catch(e){}
  try { out.selectedPoint = u(rm.replaySelectedPoint()); } catch(e){}
  try { out.serverTime = u(rm.serverTime()); } catch(e){}

  // AUTOPLAY uses the same session. If it also does nothing, the session is wedged,
  // not the step call.
  out.autoplay = {};
  var before = u(rp.currentDate());
  out.autoplay.before = before;
  try { rp.toggleAutoplay(); out.autoplay.toggled = true; } catch(e){ out.autoplay.err = String(e && e.message || e); }
  var dl = Date.now() + 12000, moved = false;
  while (Date.now() < dl) {
    var now = u(rp.currentDate());
    if (now !== before) { moved = true; out.autoplay.movedTo = now; out.autoplay.ms = 12000 - (dl - Date.now()); break; }
    await new Promise(function(r){ setTimeout(r, 200); });
  }
  out.autoplay.moved = moved;
  try { if (u(rp.isAutoplayStarted())) rp.toggleAutoplay(); } catch(e){}
  await new Promise(function(r){ setTimeout(r, 500); });
  try { out.autoplay.stillPlaying = u(rp.isAutoplayStarted()); } catch(e){}
  try { out.autoplay.after = u(rp.currentDate()); } catch(e){}
  try { return JSON.stringify(out); } catch(e) { return 'STRINGIFY_FAIL: ' + String(e && e.message || e); }
})()
