(async function () {
  var out = {};
  var req = null;
  try { window.webpackChunktradingview.push([[Math.random()], {}, function(r){ req = r; }]); } catch(e){}
  var ab = req('822530').tradingService().activeBroker();
  var api = ab._brokerConnection._brokerConnection.currentAccountApi();

  function protoSrc(obj, label) {
    var res = {};
    var o = obj, d = 0;
    while (o && d < 4) {
      Object.getOwnPropertyNames(o).forEach(function(k){
        if (k === 'constructor') return;
        try { if (typeof obj[k] === 'function') res[k] = String(obj[k]).replace(/\s+/g,' ').slice(0, 700); } catch(e){}
      });
      o = Object.getPrototypeOf(o); d++;
    }
    return res;
  }
  out.placeCap = protoSrc(api.placeOrderCapability);
  out.equityCap = protoSrc(api.equityCapability);
  out.summaryRowCap = protoSrc(api.summaryRowCapability);
  out.profitLossCap = protoSrc(api.profitLossCapability);
  out.executionsCap = protoSrc(api.executionsCapability);
  out.ordersCap = protoSrc(api.ordersCapability);
  out.positionsCap = protoSrc(api.positionsCapability);

  // is there an equity/balance number anywhere?
  out.equity = {};
  try {
    await new Promise(function(resolve){
      var done = false;
      try {
        ab.subscribeEquity(function(v){ if (!done) { done = true; out.equity.viaSubscribe = v; resolve(); } });
      } catch(e){ out.equity.subscribeErr = String(e && e.message || e); resolve(); return; }
      setTimeout(function(){ if (!done) { done = true; out.equity.viaSubscribe = 'NO CALLBACK WITHIN 3000ms'; resolve(); } }, 3000);
    });
  } catch(e){ out.equity.err = String(e && e.message || e); }
  try { ab.unsubscribeEquity && ab.unsubscribeEquity(); } catch(e){}

  try { out.transportKeys = Object.keys(api.placeOrderCapability._transport); } catch(e){}
  try { var td = api.placeOrderCapability._transport.getActiveChartTradingData();
        out.activeChartTradingData = td ? JSON.parse(JSON.stringify(td)) : null; } catch(e){ out.tradingDataErr = String(e && e.message || e); }
  try { return JSON.stringify(out); } catch(e) { return 'STRINGIFY_FAIL: ' + String(e && e.message || e); }
})()
