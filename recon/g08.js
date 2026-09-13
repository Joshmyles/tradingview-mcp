(async function () {
  var out = {};
  var req = null;
  try { window.webpackChunktradingview.push([[Math.random()], {}, function(r){ req = r; }]); } catch(e){}
  var ab = req('822530').tradingService().activeBroker();
  var api = ab._brokerConnection._brokerConnection.currentAccountApi();
  var tr = api.placeOrderCapability._transport;

  try { out.activeChartId = tr.getActiveChartId(); } catch(e){ out.activeChartIdErr = String(e && e.message || e); }
  try { out.chartIdsWithReplay = JSON.parse(JSON.stringify(tr.getChartIdsWithReplay())); } catch(e){ out.chartIdsErr = String(e && e.message || e); }
  try { out.replaySymbol = tr.getReplaySymbol(tr.getActiveChartId()); } catch(e){ out.replaySymbolErr = String(e && e.message || e); }
  try { out.selectedBarDate = tr.getSelectedBarDate(tr.getActiveChartId()); } catch(e){ out.selectedBarDateErr = String(e && e.message || e); }
  try { out.isReplayFinished = tr.isReplayFinished(tr.getActiveChartId()); } catch(e){ out.isReplayFinishedErr = String(e && e.message || e); }
  try { out.marketPrice = tr.getMarketPrice(tr.getActiveChartId()); } catch(e){ out.marketPriceErr = String(e && e.message || e); }
  try { out.symbolInfoT = JSON.parse(JSON.stringify(await tr.getSymbolInfo(tr.getActiveChartId()))); } catch(e){ out.symbolInfoTErr = String(e && e.message || e); }

  // THE ONE THAT MATTERS: user input settings carry initialCapital
  try {
    var s = await tr.getUserInputSettings(tr.getActiveChartId());
    out.userInputSettings = JSON.parse(JSON.stringify(s));
    out.userInputSettingsKeys = Object.keys(s);
  } catch(e){ out.userInputSettingsErr = String(e && e.message || e); }
  try { out.getUserInputSettingsSrc = String(tr.getUserInputSettings).replace(/\s+/g,' ').slice(0, 900); } catch(e){}
  try { out.getSelectedBarDateSrc = String(tr.getSelectedBarDate).replace(/\s+/g,' ').slice(0, 600); } catch(e){}
  try { out.isReplayFinishedSrc = String(tr.isReplayFinished).replace(/\s+/g,' ').slice(0, 600); } catch(e){}
  try { out.getActiveChartTradingDataSrc = String(tr.getActiveChartTradingData).replace(/\s+/g,' ').slice(0, 700); } catch(e){}
  try { out.sendTradingDataSrc = String(tr.sendTradingData).replace(/\s+/g,' ').slice(0, 900); } catch(e){}

  try { var eq = await api.equityCapability.getEquity(); out.equity = eq; } catch(e){ out.equityErr = String(e && e.message || e); }
  try { var pl = await api.profitLossCapability.getProfitLoss ? await api.profitLossCapability.getProfitLoss() : null; out.pl = pl; } catch(e){ out.plErr = String(e && e.message || e); }
  try { return JSON.stringify(out); } catch(e) { return 'STRINGIFY_FAIL: ' + String(e && e.message || e); }
})()
