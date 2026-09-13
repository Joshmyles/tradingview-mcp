(async function () {
  function u(v){ return (v && typeof v==='object' && typeof v.value==='function') ? v.value() : v; }
  function bars(){ try { return window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars(); } catch(e){ return null; } }
  function bstate(){ var b = bars(); if (!b || b.size() === 0) return { n: 0 };
    return { n: b.size(), first: b.valueAt(b.firstIndex())[0], last: b.valueAt(b.lastIndex())[0] }; }
  var rp = window.TradingViewApi._replayApi;
  var out = {};
  var TARGET = 1788264000; // 2026-09-01T12:00:00Z, a Tuesday midday
  try { await rp.selectDate(TARGET * 1000); } catch(e){ out.selectErr = String(e && e.message || e); }
  var dl = Date.now() + 40000, stable = 0, prev = '', st = null, arrived = false;
  while (Date.now() < dl) {
    st = bstate();
    arrived = st.n > 0 && Math.abs(st.last - TARGET) < 86400;
    var cur = JSON.stringify(st);
    if (cur === prev) stable++; else { stable = 0; prev = cur; }
    if (arrived && stable >= 3) break;
    await new Promise(function(r){ setTimeout(r, 500); });
  }
  out.afterSelect = { arrived: arrived, bars: st.n, first: st.first, last: st.last, cursor: u(rp.currentDate()) };

  out.steps = [];
  for (var i = 0; i < 6; i++) {
    var before = u(rp.currentDate()), beforeLast = bstate().last, t0 = Date.now(), moved = false;
    try { rp.doStep(); } catch(e){ out.steps.push({ err: String(e && e.message || e) }); break; }
    var d2 = Date.now() + 25000;
    while (Date.now() < d2) {
      var now = u(rp.currentDate()), bl = bstate().last;
      if (now !== before || bl !== beforeLast) {
        moved = true;
        out.steps.push({ cursorFrom: before, cursorTo: now, cursorDelta: now - before,
                         barFrom: beforeLast, barTo: bl, barDelta: bl - beforeLast, ms: Date.now() - t0 });
        break;
      }
      await new Promise(function(r){ setTimeout(r, 40); });
    }
    if (!moved) { out.steps.push({ cursorFrom: before, barFrom: beforeLast, timedOut: true, ms: Date.now() - t0 }); break; }
  }
  out.final = { cursor: u(rp.currentDate()), bars: bstate() };
  try { return JSON.stringify(out); } catch(e) { return 'STRINGIFY_FAIL: ' + String(e && e.message || e); }
})()
