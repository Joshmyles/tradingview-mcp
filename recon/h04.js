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
  var out = { probes: [] };
  var CANDIDATES = JSON.parse("[1782907200, 1777636800, 1768478400, 1748865600, 1717416000, 1702971716]");

  for (var i = 0; i < CANDIDATES.length; i++) {
    var targetSec = CANDIDATES[i];
    var rec = { targetSec: targetSec };
    var t0 = Date.now();
    try { await rp.selectDate(targetSec * 1000); } catch(e){ rec.selectErr = String(e && e.message || e); }
    // STRICT settle: the window must both stop changing AND actually land near
    // the target. The loose rule stabilised on the PREVIOUS probe's window and
    // reported a stale answer, so arrival is now part of the condition.
    var dl = Date.now() + 45000, stable = 0, prev = '', arrived = false, reads = 0, st = null;
    while (Date.now() < dl) {
      st = barState(); reads++;
      arrived = st.n > 0 && st.last !== null && Math.abs(st.last - targetSec) < 86400 * 2;
      var cur = JSON.stringify(st);
      if (cur === prev) stable++; else { stable = 0; prev = cur; }
      if (arrived && stable >= 3) break;
      await new Promise(function(r){ setTimeout(r, 700); });
    }
    rec.arrived = arrived; rec.stable = stable; rec.reads = reads;
    rec.bars = st.n; rec.first = st.first; rec.last = st.last;
    try { rec.cursor = u(rp.currentDate()); } catch(e){}
    rec.ms = Date.now() - t0;
    out.probes.push(rec);
  }
  try { return JSON.stringify(out); } catch(e) { return 'STRINGIFY_FAIL: ' + String(e && e.message || e); }
})()
