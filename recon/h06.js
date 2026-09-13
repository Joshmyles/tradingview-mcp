(async function () {
  function u(v){ return (v && typeof v==='object' && typeof v.value==='function') ? v.value() : v; }
  function series(){ return window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries(); }
  function barState(){
    try { var b = series().bars();
      if (b.size() === 0) return { n: 0, first: null, last: null };
      return { n: b.size(), first: b.valueAt(b.firstIndex())[0], last: b.valueAt(b.lastIndex())[0] };
    } catch(e){ return { n: -1, err: String(e && e.message || e) }; }
  }
  var rp = window.TradingViewApi._replayApi;
  var out = {};

  async function selectAndSettle(targetSec, maxMs) {
    var rec = { targetSec: targetSec }, t0 = Date.now();
    try { await rp.selectDate(targetSec * 1000); } catch(e){ rec.selectErr = String(e && e.message || e); }
    var dl = Date.now() + maxMs, stable = 0, prev = '', arrived = false, st = null;
    while (Date.now() < dl) {
      st = barState();
      arrived = st.n > 0 && st.last !== null && Math.abs(st.last - targetSec) < 86400 * 2;
      var cur = JSON.stringify(st);
      if (cur === prev) stable++; else { stable = 0; prev = cur; }
      if (arrived && stable >= 3) break;
      await new Promise(function(r){ setTimeout(r, 600); });
    }
    rec.arrived = arrived; rec.bars = st.n; rec.first = st.first; rec.last = st.last;
    try { rec.cursor = u(rp.currentDate()); } catch(e){}
    rec.ms = Date.now() - t0;
    return rec;
  }

  // 1. is the failure AT the depth boundary, or is everything before it dead?
  out.boundary = await selectAndSettle(1702987200, 45000); // 2023-12-19T12:00Z, ~4h after the claimed depth

  // 2. restore the session to where it was found, then measure step granularity
  out.restore = await selectAndSettle(1788739274, 45000);  // 2026-09-07T00:01:14Z, the as-found cursor

  out.steps = [];
  for (var i = 0; i < 5; i++) {
    var before = u(rp.currentDate()), t0 = Date.now(), moved = false;
    try { rp.doStep(); } catch(e){ out.steps.push({ err: String(e && e.message || e) }); break; }
    var dl = Date.now() + 30000;
    while (Date.now() < dl) {
      var now = u(rp.currentDate());
      if (now !== before) { moved = true;
        out.steps.push({ from: before, to: now, deltaSec: now - before, ms: Date.now() - t0 });
        break; }
      await new Promise(function(r){ setTimeout(r, 40); });
    }
    if (!moved) { out.steps.push({ from: before, timedOut: true, ms: Date.now() - t0 }); break; }
  }
  out.finalCursor = u(rp.currentDate());
  out.finalBars = barState();
  try { return JSON.stringify(out); } catch(e) { return 'STRINGIFY_FAIL: ' + String(e && e.message || e); }
})()
