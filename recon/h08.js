(function () {
  function u(v){ return (v && typeof v==='object' && typeof v.value==='function') ? v.value() : v; }
  var rp = window.TradingViewApi._replayApi;
  var out = {};
  ['isReplayAvailable','isReplayStarted','isAutoplayStarted','isReadyToPlay','isJumpToBarModeEnabled','isReplayToolbarVisible','replayMode','currentDate','replayTimingMode','autoReplayResolution'].forEach(function(k){
    try { var r = u(rp[k]()); out[k] = (r && typeof r === 'object') ? String(r) : r; } catch(e){ out[k] = 'ERR ' + String(e && e.message || e); }
  });
  try { out.isReplayModeEnabled = u(rp._replayUIController.isReplayModeEnabled()); } catch(e){ out.modeErr = String(e && e.message || e); }
  try { out.chartReplayStatus = String(u(window.TradingViewApi.chart(0).replayStatus())); } catch(e){ out.statusErr = String(e && e.message || e); }
  try { var b = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars();
        out.bars = b.size(); out.lastBar = b.size() ? b.valueAt(b.lastIndex())[0] : null; } catch(e){ out.barsErr = String(e && e.message || e); }
  try { var tb = document.querySelector('[data-name="replay-bottom-toolbar"]'); out.toolbarText = tb ? (tb.innerText||'').replace(/\n/g,' | ').slice(0,250) : null; } catch(e){}
  try { var rt = document.querySelector('[data-qa-id="replay_trading"]'); out.replayTradingAria = rt ? rt.getAttribute('aria-label') : null; } catch(e){}
  try { out.doStepSrcUC = String(rp._replayUIController.doStep).replace(/\s+/g,' ').slice(0,900); } catch(e){}
  try { return JSON.stringify(out); } catch(e) { return 'STRINGIFY_FAIL: ' + String(e && e.message || e); }
})()
