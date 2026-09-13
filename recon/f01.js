(function(){
  var cw = window.TradingViewApi._activeChartWidgetWV.value();
  var srcs = cw._chartWidget.model().model().dataSources();
  var out = [];
  for (var i=0;i<srcs.length;i++){
    var s = srcs[i], o = {};
    try { o.id = typeof s.id==='function'?s.id():s.id; } catch(e){}
    try { o.title = typeof s.title==='function'?s.title():s.title; } catch(e){}
    o.ctor = s && s.constructor ? s.constructor.name : null;
    o.isStudy = typeof s.metaInfo === 'function';
    o.isStrategy = typeof s.reportData === 'function';
    try { o.visible = typeof s.isVisible==='function' ? (s.isVisible().value ? s.isVisible().value() : s.isVisible()) : null; } catch(e){ o.visible='?'; }
    if (o.isStudy) {
      try { var mi = s.metaInfo();
        o.desc = mi && mi.description;
        o.shortDesc = mi && mi.shortDescription;
        o.pineId = mi && (mi.pineId || mi.productId);
        o.pineVersion = mi && mi.pineVersion;
        o.isPine = !!(mi && (mi.pine || mi.pineId));
        o.inputCount = mi && mi.inputs ? mi.inputs.length : null;
      } catch(e){ o.metaErr = String(e&&e.message||e); }
    }
    out.push(o);
  }
  return { n: out.length, sources: out };
})()
