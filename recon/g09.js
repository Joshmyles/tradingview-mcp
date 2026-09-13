(async function () {
  var out = {};
  function u(v){ return (v && typeof v==='object' && typeof v.value==='function') ? v.value() : v; }
  try {
    var props = await window.TradingViewApi.chart(0).replayStudyStrategyProperties();
    out.propsCtor = props && props.constructor ? props.constructor.name : null;
    var ch = props.childs();
    out.childKeys = Object.keys(ch).sort();
    out.childs = {};
    Object.keys(ch).forEach(function(k){
      var c = ch[k], rec = { type: typeof c };
      try { rec.value = u(c.value ? c.value() : c); } catch(e){ rec.valueErr = String(e && e.message || e); }
      try { rec.hasSetValue = typeof c.setValue === 'function'; } catch(e){}
      try { rec.hasChilds = typeof c.childs === 'function'; if (rec.hasChilds) rec.subKeys = Object.keys(c.childs()); } catch(e){}
      if (rec.value && typeof rec.value === 'object') { try { rec.value = JSON.parse(JSON.stringify(rec.value)); } catch(e){ rec.value = '[unserialisable]'; } }
      out.childs[k] = rec;
    });
    out.propsMethods = (function(){ var n={}, o=props, d=0; while(o&&d<4){ Object.getOwnPropertyNames(o).forEach(function(k){ try{ if(typeof props[k]==='function') n[k]=1; }catch(e){} }); o=Object.getPrototypeOf(o); d++; } return Object.keys(n).sort(); })();
  } catch(e){ out.err = String(e && e.message || e); }

  // B15's OWN strategy properties, for contrast: they must be a different object
  try {
    var cw = window.TradingViewApi._activeChartWidgetWV.value();
    var srcs = cw._chartWidget.model().model().dataSources();
    for (var i = 0; i < srcs.length; i++) {
      var s = srcs[i];
      var id = typeof s.id === 'function' ? s.id() : s.id;
      if (id === 'xVbiv5') {
        var api2 = cw.getStudyById(id);
        var vals = api2.getInputValues();
        out.b15_in_330 = null;
        for (var j = 0; j < vals.length; j++) if (vals[j].id === 'in_330') out.b15_in_330 = vals[j].value;
        break;
      }
    }
  } catch(e){ out.b15Err = String(e && e.message || e); }

  // the replay strategy facade itself
  try {
    var cw2 = window.TradingViewApi._activeChartWidgetWV.value();
    var f = cw2.replayStrategyFacade ? cw2.replayStrategyFacade() : null;
    out.facade = !!f;
    if (f) {
      out.facadeMethods = (function(){ var n={}, o=f, d=0; while(o&&d<4){ Object.getOwnPropertyNames(o).forEach(function(k){ try{ if(typeof f[k]==='function') n[k]=1; }catch(e){} }); o=Object.getPrototypeOf(o); d++; } return Object.keys(n).sort(); })();
      try { var rd = f.reportData(); out.reportData = rd ? JSON.parse(JSON.stringify(rd)) : null; } catch(e){ out.reportDataErr = String(e && e.message || e); }
    }
  } catch(e){ out.facadeErr = String(e && e.message || e); }
  try { return JSON.stringify(out); } catch(e) { return 'STRINGIFY_FAIL: ' + String(e && e.message || e); }
})()
