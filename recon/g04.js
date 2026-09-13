(async function () {
  function u(v){ return (v && typeof v==='object' && typeof v.value==='function') ? v.value() : v; }
  var out = {};
  var req = null;
  try { window.webpackChunktradingview.push([[Math.random()], {}, function(r){ req = r; }]); } catch(e){}
  var ab = req('822530').tradingService().activeBroker();

  // account surfaces that only an armed panel might populate
  try { out.accountsMetainfo = JSON.parse(JSON.stringify(u(ab.accountsMetainfo()))); } catch(e){ out.accountsMetainfoErr = String(e && e.message || e); }
  try { out.accountMetainfo = JSON.parse(JSON.stringify(u(ab.accountMetainfo()))); } catch(e){ out.accountMetainfoErr = String(e && e.message || e); }
  try { out.currentAccount = String(u(ab.currentAccount())); } catch(e){ out.currentAccountErr = String(e && e.message || e); }
  try { out.currentAccountType = String(u(ab.currentAccountType())); } catch(e){ out.currentAccountTypeErr = String(e && e.message || e); }
  try { out.leverageInfo = typeof ab.leverageInfo; } catch(e){}
  try { out.hasResetAccount = typeof ab.resetAccount; out.hasChangeAccountSettings = typeof ab.changeAccountSettings; } catch(e){}
  try { out.changeAccountSettingsArity = ab.changeAccountSettings.length; } catch(e){}
  try { out.resetAccountSrc = String(ab.resetAccount).slice(0, 500); } catch(e){}
  try { out.changeAccountSettingsSrc = String(ab.changeAccountSettings).slice(0, 600); } catch(e){}
  try { out.accountSettingsInfoSrc = String(ab.accountSettingsInfo).slice(0, 400); } catch(e){}

  // qty semantics: symbolInfo is a promise on this broker
  try {
    var si = await ab.symbolInfo('ICMARKETS:XAUUSD');
    out.symbolInfo = JSON.parse(JSON.stringify(si));
  } catch(e){ out.symbolInfoErr = String(e && e.message || e); }
  try { out.validationRules = JSON.parse(JSON.stringify(u(ab.getValidationRules ? ab.getValidationRules('ICMARKETS:XAUUSD') : null))); } catch(e){ out.validationRulesErr = String(e && e.message || e); }
  try { var ipo = await ab.createInitialPreOrder({ symbol: 'ICMARKETS:XAUUSD' }); out.initialPreOrder = JSON.parse(JSON.stringify(ipo)); } catch(e){ out.initialPreOrderErr = String(e && e.message || e); }

  // the ARMED panel's own DOM
  out.panel = {};
  try {
    var tb = document.querySelector('[data-name="replay-bottom-toolbar"]');
    out.panel.found = !!tb;
    if (tb) {
      out.panel.text = (tb.innerText || '').slice(0, 600);
      out.panel.controls = Array.prototype.slice.call(tb.querySelectorAll('button,input,select,[role="button"],[data-name]')).slice(0, 40).map(function(n){
        return { tag: n.tagName, dn: n.getAttribute('data-name'), qa: n.getAttribute('data-qa-id'), aria: n.getAttribute('aria-label'), title: n.getAttribute('title'), val: n.value !== undefined ? String(n.value).slice(0,30) : null, txt: (n.innerText||'').trim().slice(0,40) };
      });
    }
  } catch(e){ out.panelErr = String(e && e.message || e); }
  try {
    var cur = document.querySelector('[data-name="currency-label-selector"], [data-name="currency-unit-label-wrapper"]');
    out.panel.currencyLabel = cur ? { txt: (cur.innerText||'').trim().slice(0,80), aria: cur.getAttribute('aria-label'), html: cur.outerHTML.slice(0, 400) } : null;
  } catch(e){}
  try { return JSON.stringify(out); } catch(e) { return 'STRINGIFY_FAIL: ' + String(e && e.message || e); }
})()
