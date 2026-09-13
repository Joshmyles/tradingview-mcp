(async function () {
  function u(v){ return (v && typeof v==='object' && typeof v.value==='function') ? v.value() : v; }
  var rp = window.TradingViewApi._replayApi;
  var uc = rp._replayUIController;
  var out = { phases: [] };
  function snap(tag){
    var s = { tag: tag };
    try { s.started = u(rp.isReplayStarted()); } catch(e){}
    try { s.modeEnabled = u(uc.isReplayModeEnabled()); } catch(e){}
    try { s.cursor = u(rp.currentDate()); } catch(e){}
    try { s.models = uc._replayManager.models().length; } catch(e){ s.modelsErr = String(e && e.message || e); }
    try { var b = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars();
          s.bars = b.size(); s.lastBar = b.size() ? b.valueAt(b.lastIndex())[0] : null; } catch(e){}
    return s;
  }
  out.phases.push(snap('before'));

  try { await rp.leaveReplay(); out.left = true; } catch(e){ out.leaveErr = String(e && e.message || e); }
  var dl = Date.now() + 20000;
  while (Date.now() < dl) { if (!u(rp.isReplayStarted())) break; await new Promise(function(r){ setTimeout(r, 200); }); }
  out.phases.push(snap('after_leave'));

  try { await rp.selectDate(1788220800 * 1000); } catch(e){ out.selectErr = String(e && e.message || e); }
  var dl2 = Date.now() + 40000, stable = 0, prev = '';
  while (Date.now() < dl2 && stable < 4) {
    var s = JSON.stringify(snap('poll'));
    if (s === prev) stable++; else { stable = 0; prev = s; }
    await new Promise(function(r){ setTimeout(r, 500); });
  }
  out.phases.push(snap('after_reselect'));

  out.steps = [];
  for (var i = 0; i < 4; i++) {
    var before = u(rp.currentDate()), t0 = Date.now();
    var r = await new Promise(function(resolve){
      var done = false;
      try { var p = rp.doStep();
        if (p && p.then) p.then(function(){ if(!done){done=true;resolve('resolved');} }, function(e){ if(!done){done=true;resolve('rejected:'+String(e&&e.message||e));} });
        else { done=true; resolve('sync'); }
      } catch(e){ done=true; resolve('threw:'+String(e&&e.message||e)); }
      setTimeout(function(){ if(!done){done=true;resolve('PENDING');} }, 20000);
    });
    var after = u(rp.currentDate());
    out.steps.push({ outcome: r, from: before, to: after, delta: after - before, ms: Date.now() - t0 });
    if (after === before) break;
  }
  out.phases.push(snap('final'));
  try { return JSON.stringify(out); } catch(e) { return 'STRINGIFY_FAIL: ' + String(e && e.message || e); }
})()
