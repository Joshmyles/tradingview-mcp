(function () {
  function u(v){ return (v && typeof v==='object' && typeof v.value==='function') ? v.value() : v; }
  var out = {};
  var rp = window.TradingViewApi._replayApi;
  var uc = rp._replayUIController;
  try {
    var rdv = u(uc._replayResolutionsDepth);
    var m = {};
    if (rdv) Object.keys(rdv).forEach(function(k){ m[k] = u(rdv[k]); });
    out.resolutionDepth = m;
  } catch(e){ out.resErr = String(e && e.message || e); }
  try { out.genericDepth = u(uc._replayDepth); } catch(e){}
  try { out.currentResolution = u(rp.currentReplayResolution ? rp.currentReplayResolution() : null); } catch(e){ out.curResErr = String(e && e.message || e); }
  try { out.replayResolutions = JSON.parse(JSON.stringify(u(rp.replayResolutions()))); } catch(e){ out.replayResolutionsErr = String(e && e.message || e); }
  try { out.autoReplayResolution = u(rp.autoReplayResolution()); } catch(e){}
  try { out.selectedDate = u(rp.getReplaySelectedDate()); } catch(e){}
  try { out.currentDate = u(rp.currentDate()); } catch(e){}
  try { out.isReadyToPlay = u(rp.isReadyToPlay()); } catch(e){}
  try { out.selectFirstAvailableDateSrc = String(rp.selectFirstAvailableDate).replace(/\s+/g,' ').slice(0,700); } catch(e){}
  try { out.onPointSelectedSrc = String(uc._onPointSelected).replace(/\s+/g,' ').slice(0,1200); } catch(e){}
  try { out.doStepSrc = String(rp.doStep).replace(/\s+/g,' ').slice(0,500); } catch(e){}
  try { return JSON.stringify(out); } catch(e) { return 'STRINGIFY_FAIL: ' + String(e && e.message || e); }
})()
