(async function () {
  function u(v){ return (v && typeof v==='object' && typeof v.value==='function') ? v.value() : v; }
  var out = { steps: [] };
  var req = null;
  try { window.webpackChunktradingview.push([[Math.random()], {}, function(r){ req = r; }]); } catch(e){}
  function tsvc(){ return req('822530').tradingService(); }
  function snap(tag) {
    var s = { tag: tag, t: Date.now() };
    try { s.broker = u(tsvc().activeBroker().currentBroker()); } catch(e){ s.brokerErr = String(e && e.message || e); }
    try { s.isInReplay = u(tsvc().isInReplay()); } catch(e){}
    try { s.conn = u(tsvc().activeBroker().connectionStatus()); } catch(e){}
    try { var am = tsvc().activeBroker().accountManagerInfo(); s.summaryLen = am && am.summary ? am.summary.length : null; } catch(e){ s.amErr = String(e && e.message || e); }
    try { tsvc().activeBroker().accountSettingsInfo(); s.acctSettings = 'present'; } catch(e){ s.acctSettings = 'THROWS'; }
    var btn = document.querySelector('[data-qa-id="replay_trading"]');
    s.btnAria = btn ? btn.getAttribute('aria-label') : null;
    try { var uc = window.TradingViewApi._replayApi._replayUIController;
          var tu = uc.tradingUIController ? uc.tradingUIController() : null;
          s.tradingUI = !!tu;
          s.connectedFlag = tu ? tu._isConnectedToBroker : null;
          s.modelMapSize = (tu && tu._tradingModelMap) ? tu._tradingModelMap.size : null;
          s.activeModel = !!(tu && tu.activeModel && tu.activeModel()); } catch(e){ s.uiErr = String(e && e.message || e); }
    return s;
  }
  out.steps.push(snap('before'));

  var btn = document.querySelector('[data-qa-id="replay_trading"]');
  if (!btn) { out.error = 'replay_trading button not found'; return JSON.stringify(out); }
  out.clickedAria = btn.getAttribute('aria-label');
  btn.click();

  // advancement confirmed by OBSERVED STATE CHANGE, not by a sleep: poll until
  // the button's own label flips (Open -> Close) or the account manager fills.
  var deadline = Date.now() + 15000, changed = false, polls = 0;
  while (Date.now() < deadline) {
    polls++;
    var b2 = document.querySelector('[data-qa-id="replay_trading"]');
    var aria = b2 ? b2.getAttribute('aria-label') : null;
    var summaryLen = null;
    try { var am = tsvc().activeBroker().accountManagerInfo(); summaryLen = am && am.summary ? am.summary.length : null; } catch(e){}
    if ((aria && aria !== out.clickedAria) || (summaryLen && summaryLen > 0)) { changed = true; break; }
    await new Promise(function(r){ setTimeout(r, 120); });
  }
  out.polls = polls;
  out.observedChange = changed;
  out.steps.push(snap('after'));
  try { return JSON.stringify(out); } catch(e) { return 'STRINGIFY_FAIL: ' + String(e && e.message || e); }
})()
