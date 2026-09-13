(function () {
  var out = {};
  var req = null;
  try { window.webpackChunktradingview.push([[Math.random()], {}, function(r){ req = r; }]); } catch(e){}
  var ab = req('822530').tradingService().activeBroker();
  var bc = ab._brokerConnection;

  // the capability layer: the authoritative order-object shape
  try {
    var api = bc._brokerConnection.currentAccountApi();
    out.capabilityKeys = Object.keys(api).sort();
    var names = {}, o = api, d = 0;
    while (o && d < 5) { Object.getOwnPropertyNames(o).forEach(function(k){ names[k] = typeof api[k]; }); o = Object.getPrototypeOf(o); d++; }
    out.apiMembers = names;
    try { out.placeOrderCapSrc = String(api.placeOrderCapability.placeOrder).replace(/\s+/g,' ').slice(0, 1800); } catch(e){ out.placeCapErr = String(e && e.message || e); }
    try { out.placeOrderCapKeys = Object.keys(api.placeOrderCapability); } catch(e){}
    try { out.modifyCapSrc = String(api.modifyOrderCapability.modifyOrder).replace(/\s+/g,' ').slice(0, 900); } catch(e){}
    try { out.closeCapSrc = String(api.closePositionCapability.closePosition).replace(/\s+/g,' ').slice(0, 900); } catch(e){}
    try { out.executionsCapSrc = String(api.executionsCapability.executions).replace(/\s+/g,' ').slice(0, 900); } catch(e){}
  } catch(e){ out.capErr = String(e && e.message || e); }

  // summary rows: why accountManagerInfo().summary is empty
  try { out.summaryRowFieldsSize = bc._summaryRowFields ? bc._summaryRowFields.size : null; } catch(e){}

  // does the UI offer capital / currency / commission ANYWHERE right now?
  out.text = {};
  try {
    var body = document.body.innerText || '';
    ['Initial capital','initial capital','Commission','commission','Balance','Equity','Currency','Leverage','Reset account','Account settings','Replay Trading'].forEach(function(w){
      var i = body.indexOf(w);
      out.text[w] = i < 0 ? null : body.slice(Math.max(0, i - 60), i + 90).replace(/\n/g, ' | ');
    });
  } catch(e){ out.textErr = String(e && e.message || e); }
  try {
    var inputs = Array.prototype.slice.call(document.querySelectorAll('input')).slice(0, 40).map(function(n){
      return { name: n.getAttribute('name'), dn: n.getAttribute('data-name'), ph: n.getAttribute('placeholder'), aria: n.getAttribute('aria-label'), val: String(n.value).slice(0,24), vis: !!(n.offsetWidth||n.offsetHeight) };
    });
    out.inputs = inputs.filter(function(x){ return x.vis; });
  } catch(e){}
  try { return JSON.stringify(out); } catch(e) { return 'STRINGIFY_FAIL: ' + String(e && e.message || e); }
})()
