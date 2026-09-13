(function () {
  function u(v){ return (v && typeof v==='object' && typeof v.value==='function') ? v.value() : v; }
  var out = {};
  var req = null;
  try { window.webpackChunktradingview.push([[Math.random()], {}, function(r){ req = r; }]); } catch(e){}
  var ab = req('822530').tradingService().activeBroker();

  // the three flags accountSettingsInfo() actually gates on
  try { var cf = ab.metainfo().configFlags;
        out.gateFlags = { supportCreateAccount: cf.supportCreateAccount,
                          supportResetAccount: cf.supportResetAccount,
                          supportChangeAccountSettings: cf.supportChangeAccountSettings,
                          supportBalances: cf.supportBalances, supportMargin: cf.supportMargin,
                          supportLeverage: cf.supportLeverage, supportExecutions: cf.supportExecutions };
        out.allFlagKeys = Object.keys(cf).length;
  } catch(e){ out.flagErr = String(e && e.message || e); }

  // definitive order-object shape: the source of the call itself
  out.src = {};
  ['placeOrder','_placeOrder','previewOrder','modifyOrder','cancelOrder','closePosition','editPositionBrackets','reversePosition','executions','allExecutions','orders','positions','isTradable'].forEach(function(k){
    try { out.src[k] = String(ab[k]).replace(/\s+/g,' ').slice(0, 700); } catch(e){ out.src[k] = 'ERR ' + String(e && e.message || e); }
  });

  // the underlying replay broker connection, which is where the real logic lives
  try {
    var bc = ab._brokerConnection;
    out.connection = { ctor: bc && bc.constructor ? bc.constructor.name : null };
    var names = {}, o = bc, d = 0;
    while (o && d < 6) { Object.getOwnPropertyNames(o).forEach(function(k){ try { if (typeof bc[k] === 'function') names[k] = true; } catch(e){} }); o = Object.getPrototypeOf(o); d++; }
    out.connection.methods = Object.keys(names).sort();
    try { out.connection.placeOrderSrc = String(bc.placeOrder).replace(/\s+/g,' ').slice(0, 1400); } catch(e){}
    try { out.connection.accountManagerInfoSrc = String(bc.accountManagerInfo).replace(/\s+/g,' ').slice(0, 900); } catch(e){}
    try { out.connection.symbolInfoSrc = String(bc.symbolInfo).replace(/\s+/g,' ').slice(0, 900); } catch(e){}
  } catch(e){ out.connErr = String(e && e.message || e); }

  // where are the buy/sell buttons?
  out.dom = {};
  try {
    ['buy-order-button','sell-order-button'].forEach(function(n){
      var el = document.querySelector('[data-name="' + n + '"]');
      out.dom[n] = el ? { txt: (el.innerText||'').trim().slice(0,60), aria: el.getAttribute('aria-label'),
                          parentChain: (function(){ var p = el, c = []; for (var i=0;i<6 && p;i++){ c.push((p.getAttribute && (p.getAttribute('data-name')||p.getAttribute('data-qa-id'))) || p.tagName); p = p.parentElement; } return c; })(),
                          visible: !!(el.offsetWidth || el.offsetHeight) } : null;
    });
  } catch(e){ out.domErr = String(e && e.message || e); }
  try { return JSON.stringify(out); } catch(e) { return 'STRINGIFY_FAIL: ' + String(e && e.message || e); }
})()
