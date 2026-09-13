(async function () {
  function u(v){ return (v && typeof v==='object' && typeof v.value==='function') ? v.value() : v; }
  var out = { steps: [] };
  var rp = window.TradingViewApi._replayApi;
  function snap(tag) {
    var s = { tag: tag, wall: Date.now() };
    try { s.currentDate = u(rp.currentDate()); } catch(e){}
    try { s.selectedDate = u(rp.getReplaySelectedDate()); } catch(e){}
    try { s.started = u(rp.isReplayStarted()); } catch(e){}
    try { s.ready = u(rp.isReadyToPlay()); } catch(e){}
    try {
      var ms = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries();
      var b = ms.bars();
      s.barCount = b.size();
      if (b.size() > 0) { s.firstBar = b.valueAt(b.firstIndex())[0]; s.lastBar = b.valueAt(b.lastIndex())[0]; }
      s.resolution = ms.interval();
    } catch(e){ s.seriesErr = String(e && e.message || e); }
    return s;
  }
  out.steps.push(snap('before'));

  try { await rp.selectFirstAvailableDate(); out.called = 'selectFirstAvailableDate resolved'; }
  catch(e){ out.callErr = String(e && e.message || e); }

  // advancement confirmed by OBSERVED STATE CHANGE: wait for the cursor to move
  // away from where it was, or for the bar window to change. Timeout is failure
  // detection only, not synchronisation.
  var before = out.steps[0].currentDate, deadline = Date.now() + 60000, moved = false, polls = 0;
  while (Date.now() < deadline) {
    polls++;
    var now = null, first = null;
    try { now = u(rp.currentDate()); } catch(e){}
    try { var b = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars();
          if (b.size() > 0) first = b.valueAt(b.firstIndex())[0]; } catch(e){}
    if ((now !== null && now !== before) || (first !== null && first !== out.steps[0].firstBar)) { moved = true; break; }
    await new Promise(function(r){ setTimeout(r, 250); });
  }
  out.polls = polls; out.observedChange = moved;
  out.steps.push(snap('after_select'));

  // let history settle: poll until the first loaded bar stops moving for 3 reads
  var stable = 0, lastFirst = null, dl2 = Date.now() + 45000;
  while (Date.now() < dl2 && stable < 3) {
    var f = null;
    try { var bb = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars();
          if (bb.size() > 0) f = bb.valueAt(bb.firstIndex())[0]; } catch(e){}
    if (f === lastFirst) stable++; else { stable = 0; lastFirst = f; }
    await new Promise(function(r){ setTimeout(r, 700); });
  }
  out.steps.push(snap('after_settle'));
  try { return JSON.stringify(out); } catch(e) { return 'STRINGIFY_FAIL: ' + String(e && e.message || e); }
})()
