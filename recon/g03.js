(function () {
  function u(v){ return (v && typeof v==='object' && typeof v.value==='function') ? v.value() : v; }
  var out = {};
  var req = null;
  try { window.webpackChunktradingview.push([[Math.random()], {}, function(r){ req = r; }]); } catch(e){}
  var ts = req('822530').tradingService();
  var ab = ts.activeBroker();

  out.broker = {};
  try { out.broker.current = u(ab.currentBroker()); } catch(e){}
  try { out.broker.conn = u(ab.connectionStatus()); } catch(e){}
  try { out.broker.isInReplay = u(ts.isInReplay()); } catch(e){}
  try { out.broker.replayStarted = u(window.TradingViewApi._replayApi.isReplayStarted()); } catch(e){}
  try { out.broker.currency = u(window.TradingViewApi._replayApi.currency()); } catch(e){}

  // 1. capital / currency / commission surfaces
  out.capital = {};
  try { ab.accountSettingsInfo(); out.capital.accountSettingsInfo = 'PRESENT'; }
  catch(e){ out.capital.accountSettingsInfo = 'THROWS: ' + String(e && e.message || e); }
  try { var am = ab.accountManagerInfo();
        out.capital.amKeys = Object.keys(am);
        out.capital.summary = am.summary ? am.summary.map(function(x){ return { text: x.text, value: (typeof x.value === 'function' ? String(u(x.value())) : String(x.value)) }; }) : null;
        out.capital.accountTitle = am.accountTitle ? String(u(am.accountTitle)) : null;
  } catch(e){ out.capital.amErr = String(e && e.message || e); }
  try { var mi = ab.metainfo();
        out.capital.configFlags = mi.configFlags ? JSON.parse(JSON.stringify(mi.configFlags)) : null;
        out.capital.brokerTitle = mi.title;
  } catch(e){ out.capital.miErr = String(e && e.message || e); }
  try { out.capital.accounts = u(ab.accountsMetainfo ? ab.accountsMetainfo() : null); } catch(e){ out.capital.accountsErr = String(e && e.message || e); }

  // 2. method surface, walking the prototype chain
  var names = {}, o = ab, depth = 0;
  while (o && depth < 6) {
    Object.getOwnPropertyNames(o).forEach(function(k){ try { if (typeof ab[k] === 'function') names[k] = true; } catch(e){} });
    o = Object.getPrototypeOf(o); depth++;
  }
  out.methods = Object.keys(names).sort();
  var WANT = ['placeOrder','modifyOrder','cancelOrder','cancelOrders','closePosition','reversePosition',
              'editPositionBrackets','orders','positions','executions','allExecutions','ordersHistory',
              'accountManagerInfo','symbolInfo','previewOrder','chartContextMenuActions','isTradable'];
  out.wanted = {};
  WANT.forEach(function(k){ out.wanted[k] = typeof ab[k]; });

  // 3. symbolInfo for qty semantics
  try {
    var si = ab.symbolInfo ? ab.symbolInfo('ICMARKETS:XAUUSD') : null;
    if (si && typeof si.then === 'function') { out.symbolInfo = 'PROMISE'; }
    else out.symbolInfo = si ? JSON.parse(JSON.stringify(si)) : null;
  } catch(e){ out.symbolInfoErr = String(e && e.message || e); }

  // 4. readers
  try { out.orders = (u(ab.orders()) || []).length; } catch(e){ out.ordersErr = String(e && e.message || e); }
  try { out.positions = (u(ab.positions()) || []).length; } catch(e){ out.positionsErr = String(e && e.message || e); }
  try { out.executions = typeof ab.executions; } catch(e){}

  // 5. enums
  try { var em = req('601629');
        out.enums = { Side: em.Side, OrderType: em.OrderType, OrderStatus: em.OrderStatus, ParentType: em.ParentType };
  } catch(e){ out.enumsErr = String(e && e.message || e); }
  try { var bm = req('754318'); out.internalBrokerId = bm.InternalBrokerId || null; } catch(e){ out.brokerIdErr = String(e && e.message || e); }

  // 6. the panel DOM: what fields does the armed panel actually expose?
  out.dom = {};
  try {
    var ids = [];
    document.querySelectorAll('[data-qa-id]').forEach(function(n){ var v=n.getAttribute('data-qa-id'); if(v && ids.indexOf(v)<0) ids.push(v); });
    out.dom.qaIds = ids.slice(0, 120);
  } catch(e){}
  try {
    var names2 = [];
    document.querySelectorAll('[data-name]').forEach(function(n){ var v=n.getAttribute('data-name'); if(v && /replay|trad|order|position|account|broker|capital|commission|currenc/i.test(v) && names2.indexOf(v)<0) names2.push(v); });
    out.dom.relevantDataNames = names2.slice(0, 80);
  } catch(e){}
  try { return JSON.stringify(out); } catch(e) { return 'STRINGIFY_FAIL: ' + String(e && e.message || e); }
})()
