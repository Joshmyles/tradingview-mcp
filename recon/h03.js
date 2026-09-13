(async function () {
  function u(v){ return (v && typeof v==='object' && typeof v.value==='function') ? v.value() : v; }
  function series(){ return window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries(); }
  function barState(){
    try { var b = series().bars();
      if (b.size() === 0) return { n: 0, first: null, last: null };
      return { n: b.size(), first: b.valueAt(b.firstIndex())[0], last: b.valueAt(b.lastIndex())[0] };
    } catch(e){ return { err: String(e && e.message || e) }; }
  }
  // Settle rule: the bar window must stop changing for 4 consecutive reads.
  // A timeout is failure detection, never the synchronisation itself.
  async function settle(maxMs) {
    var dl = Date.now() + maxMs, stable = 0, prev = JSON.stringify(barState()), reads = 1;
    while (Date.now() < dl && stable < 4) {
      await new Promise(function(r){ setTimeout(r, 600); });
      var cur = JSON.stringify(barState()); reads++;
      if (cur === prev) stable++; else { stable = 0; prev = cur; }
    }
    return { settled: stable >= 4, reads: reads, state: barState() };
  }

  var rp = window.TradingViewApi._replayApi;
  var out = { probes: [] };
  var CANDIDATES = JSON.parse("[1788264000, 1787659200, 1787054400, 1786449600]");
  for (var i = 0; i < CANDIDATES.length; i++) {
    var targetSec = CANDIDATES[i];
    var rec = { targetSec: targetSec };
    var t0 = Date.now();
    try { await rp.selectDate(targetSec * 1000); } catch(e){ rec.selectErr = String(e && e.message || e); }
    var s = await settle(30000);
    rec.settled = s.settled; rec.reads = s.reads; rec.bars = s.state.n;
    rec.first = s.state.first; rec.last = s.state.last;
    try { rec.cursor = u(rp.currentDate()); } catch(e){}
    rec.ms = Date.now() - t0;
    out.probes.push(rec);
  }
  try { return JSON.stringify(out); } catch(e) { return 'STRINGIFY_FAIL: ' + String(e && e.message || e); }
})()
