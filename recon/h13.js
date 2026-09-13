(async function () {
  function u(v){ return (v && typeof v==='object' && typeof v.value==='function') ? v.value() : v; }
  var rp = window.TradingViewApi._replayApi;
  var rm = rp._replayUIController._replayManager;
  var out = { log: [] };
  function state(tag){
    var s = { tag: tag };
    try { s.models = rm.models().map(function(m){ return String(m.id()); }); } catch(e){ s.modelsErr = String(e && e.message || e); }
    try { s.connected = u(rm.isReplayConnected()); } catch(e){}
    try { s.started = u(rm.isReplayStarted()); } catch(e){}
    try { s.finished = u(rm.isReplayFinished()); } catch(e){}
    try { s.cursor = u(rp.currentDate()); } catch(e){}
    return s;
  }
  async function step(tag){
    var before = u(rp.currentDate()), t0 = Date.now();
    var r = await new Promise(function(resolve){
      var done = false;
      try { var p = rp.doStep();
        if (p && p.then) p.then(function(){ if(!done){done=true;resolve('resolved');} }, function(e){ if(!done){done=true;resolve('rejected:'+String(e&&e.message||e));} });
        else { done=true; resolve('sync'); }
      } catch(e){ done=true; resolve('threw:'+String(e&&e.message||e)); }
      setTimeout(function(){ if(!done){done=true;resolve('PENDING');} }, 15000);
    });
    var after = u(rp.currentDate());
    return { tag: tag, outcome: r, from: before, to: after, delta: after - before, ms: Date.now() - t0 };
  }

  out.log.push(state('start'));
  // remove the "_additional" model that arming Replay Trading attached
  try {
    var extra = rm.models().filter(function(m){ return String(m.id()).indexOf('_additional') >= 0; });
    out.extraFound = extra.length;
    for (var i = 0; i < extra.length; i++) rm.removeModel(extra[i]);
    out.removed = true;
  } catch(e){ out.removeErr = String(e && e.message || e); }
  var dl = Date.now() + 8000;
  while (Date.now() < dl) { if (rm.models().length === 1) break; await new Promise(function(r){ setTimeout(r, 200); }); }
  out.log.push(state('after_remove'));
  out.step1 = await step('after_remove');

  if (out.step1.delta === 0) {
    try { rm.disconnectionSessionIfExists(); out.disconnected = true; } catch(e){ out.disconnectErr = String(e && e.message || e); }
    var dl2 = Date.now() + 10000;
    while (Date.now() < dl2) { if (u(rm.isReplayConnected())) break; await new Promise(function(r){ setTimeout(r, 250); }); }
    out.log.push(state('after_disconnect'));
    try { await rp.selectDate(1788220800 * 1000); } catch(e){ out.reselectErr = String(e && e.message || e); }
    var dl3 = Date.now() + 30000;
    while (Date.now() < dl3) { if (u(rm.isReplayStarted()) && u(rm.isReplayConnected())) break; await new Promise(function(r){ setTimeout(r, 400); }); }
    out.log.push(state('after_reselect'));
    out.step2 = await step('after_reconnect');
  }
  out.log.push(state('final'));
  try { return JSON.stringify(out); } catch(e) { return 'STRINGIFY_FAIL: ' + String(e && e.message || e); }
})()
