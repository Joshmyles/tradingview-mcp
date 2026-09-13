(function () {
  function u(v){ return (v && typeof v==='object' && typeof v.value==='function') ? v.value() : v; }
  var uc = window.TradingViewApi._replayApi._replayUIController;
  var rm = uc._replayManager;
  var out = {};
  try {
    out.models = rm.models().map(function(m){
      var o = { ctor: m && m.constructor ? m.constructor.name : null };
      try { o.id = typeof m.id === 'function' ? String(m.id()) : String(m.id); } catch(e){}
      try { o.symbol = typeof m.symbol === 'function' ? String(m.symbol()) : null; } catch(e){}
      try { o.resolution = typeof m.resolution === 'function' ? String(m.resolution()) : null; } catch(e){}
      try { o.keys = Object.keys(m).slice(0, 25); } catch(e){}
      return o;
    });
  } catch(e){ out.modelsErr = String(e && e.message || e); }
  try { out.replayableModels = (u(uc._replayableModels) || []).map(function(m){
      var o = { ctor: m && m.constructor ? m.constructor.name : null };
      try { o.id = typeof m.id === 'function' ? String(m.id()) : String(m.id); } catch(e){}
      return o; }); } catch(e){ out.replayableErr = String(e && e.message || e); }
  try { out.currentChartId = String(uc._currentChartId); } catch(e){}
  try { out.replayModeProperty = String(u(uc._replayManager._replayMode ? uc._replayManager._replayMode : null)); } catch(e){}
  try { out.sessionKeys = Object.keys(rm._replaySession || {}).slice(0, 30); } catch(e){ out.sessErr = String(e && e.message || e); }
  try { out.sessionCtor = rm._replaySession && rm._replaySession.constructor ? rm._replaySession.constructor.name : null; } catch(e){}
  try { out.rmMethods = (function(){ var n={}, o=rm, d=0; while(o&&d<4){ Object.getOwnPropertyNames(o).forEach(function(k){ try{ if(typeof rm[k]==='function') n[k]=1; }catch(e){} }); o=Object.getPrototypeOf(o); d++; } return Object.keys(n).sort(); })(); } catch(e){}
  try { out.chartWidgets = window.TradingViewApi._chartWidgetCollection.getAll().length; } catch(e){ out.cwErr = String(e && e.message || e); }
  try { return JSON.stringify(out); } catch(e) { return 'STRINGIFY_FAIL: ' + String(e && e.message || e); }
})()
