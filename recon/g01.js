(function () {
  var out = {};
  function u(v){ return (v && typeof v==='object' && typeof v.value==='function') ? v.value() : v; }
  var rp = window.TradingViewApi._replayApi;
  out.replay = {};
  try { out.replay.available = u(rp.isReplayAvailable()); } catch(e){ out.replay.availableErr = String(e); }
  try { out.replay.started = u(rp.isReplayStarted()); } catch(e){}
  try { out.replay.autoplay = u(rp.isAutoplayStarted()); } catch(e){}
  try { var md = u(rp.replayMode()); out.replay.mode = (md && typeof md==='object') ? String(md) : md; } catch(e){}
  try { out.replay.currentDate_sec = u(rp.currentDate()); } catch(e){}
  try { out.replay.currency = u(rp.currency()); } catch(e){}
  try { var pz = u(rp.position()); out.replay.position = (pz && typeof pz === 'object') ? (pz.qty !== undefined ? pz.qty : JSON.stringify(Object.keys(pz))) : pz; } catch(e){}
  try { out.replay.realizedPL = u(rp.realizedPL()); } catch(e){}
  try { var uc = rp._replayUIController; out.ui = {
      depth: uc._replayDepth,
      resDepth: JSON.parse(JSON.stringify(uc._replayResolutionsDepth || null)),
      hasTradingUI: typeof uc.tradingUIController === 'function',
      tradingUI: !!(uc.tradingUIController && uc.tradingUIController()),
      connectedToBroker: uc.tradingUIController && uc.tradingUIController() ? uc.tradingUIController()._isConnectedToBroker : null,
      modelMapSize: (uc.tradingUIController && uc.tradingUIController() && uc.tradingUIController()._tradingModelMap) ? uc.tradingUIController()._tradingModelMap.size : null,
      activeModel: !!(uc.tradingUIController && uc.tradingUIController() && uc.tradingUIController().activeModel && uc.tradingUIController().activeModel()),
    }; } catch(e){ out.uiErr = String(e && e.message || e); }

  // webpack module registry
  var req = null;
  try { window.webpackChunktradingview.push([[Math.random()], {}, function(r){ req = r; }]); } catch(e){ out.reqErr = String(e && e.message || e); }
  out.webpack = !!req;
  if (req) {
    try {
      var ts = req('822530').tradingService();
      out.trading = { isInReplay: null, broker: null };
      try { out.trading.isInReplay = u(ts.isInReplay()); } catch(e){ out.trading.isInReplayErr = String(e && e.message || e); }
      var ab = null;
      try { ab = ts.activeBroker(); } catch(e){ out.trading.activeBrokerErr = String(e && e.message || e); }
      out.trading.hasActiveBroker = !!ab;
      if (ab) {
        try { out.trading.currentBroker = u(ab.currentBroker()); } catch(e){}
        try { out.trading.connectionStatus = u(ab.connectionStatus()); } catch(e){}
        try { var am = ab.accountManagerInfo(); out.trading.summaryLen = am && am.summary ? am.summary.length : null;
              out.trading.accountId = am ? String(am.accountId) : null; } catch(e){ out.trading.amErr = String(e && e.message || e); }
        try { ab.accountSettingsInfo(); out.trading.accountSettings = 'present'; } catch(e){ out.trading.accountSettings = 'THROWS: ' + String(e && e.message || e); }
        try { var cfg = ab.metainfo ? ab.metainfo() : (ab.configFlags ? ab.configFlags() : null); out.trading.metainfoKeys = cfg ? Object.keys(cfg).slice(0,40) : null; } catch(e){}
        out.trading.methods = Object.keys(Object.getPrototypeOf(ab)).filter(function(k){ return typeof ab[k]==='function'; }).sort();
      }
      try { out.trading.brokersListLen = ts.brokersList().length; } catch(e){}
    } catch(e){ out.tradingErr = String(e && e.message || e); }
  }

  // DOM: replay toolbar + replay trading button
  out.dom = {};
  try {
    var rt = document.querySelector('[data-qa-id="replay_trading"]');
    out.dom.replayTradingBtn = rt ? { text: (rt.textContent||'').trim().slice(0,60), aria: rt.getAttribute('aria-label'), pressed: rt.getAttribute('aria-pressed'), cls: (rt.className||'').slice(0,120) } : null;
  } catch(e){}
  try { out.dom.toolbarPresent = !!document.querySelector('[class*="replayToolbar"], [data-name="replay-toolbar"]'); } catch(e){}
  try {
    var panel = document.querySelector('[data-name="bottom-area"], .bottom-widgetbar-content');
    out.dom.bottomTabs = panel ? Array.prototype.slice.call(panel.querySelectorAll('[data-name], [data-id]')).slice(0,25).map(function(n){ return (n.getAttribute('data-name')||n.getAttribute('data-id')) + ':' + (n.textContent||'').trim().slice(0,25); }) : null;
  } catch(e){}
  try { return JSON.stringify(out); } catch (e) { return 'STRINGIFY_FAIL: ' + String(e && e.message || e); }
})()
